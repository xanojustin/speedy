//! U4: PTY spawn, write, resize, exit tracking, and process-group teardown.
//!
//! Tauri-free so it can be driven directly from tests: `PtySession` is one
//! shell on one PTY, `PtyHost` maps terminal ids to sessions. `PtyManager`
//! (mod.rs) wraps the host with Tauri channels and app events.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow};
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::PtyExit;
use super::coalesce::Coalescer;
use crate::proc_group;

/// Receives coalesced output frames. Swappable so a reloaded webview can rebind.
pub type OutputSink = Box<dyn FnMut(Vec<u8>) + Send>;
/// Called once with the shell's exit code (`None` when killed by a signal).
pub type ExitCallback = Box<dyn FnOnce(Option<i32>) + Send>;

/// How long the exit callback waits for the last output to drain after the
/// shell exits (a background job can keep the PTY open indefinitely).
const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(500);
const READ_CHUNK: usize = 64 * 1024;

/// What to start: `shell -l` in `cwd` with `env` (plus the terminal vars).
pub struct PtySpawn {
    pub shell: String,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// The user's login shell from `env`, falling back to zsh (the macOS default).
pub fn login_shell(env: &HashMap<String, String>) -> String {
    env.get("SHELL").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| "/bin/zsh".into())
}

/// One login shell on one PTY. The shell is a session leader, so its process
/// group id equals its pid.
pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: mpsc::Sender<Vec<u8>>,
    sink: Arc<Mutex<OutputSink>>,
    pid: i32,
}

impl PtySession {
    pub fn spawn(spec: PtySpawn, sink: OutputSink, on_exit: ExitCallback) -> anyhow::Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows.max(1), cols: spec.cols.max(1), pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        let mut cmd = CommandBuilder::new(&spec.shell);
        cmd.arg("-l");
        cmd.cwd(&spec.cwd);
        if !spec.env.is_empty() {
            cmd.env_clear();
            for (k, v) in &spec.env {
                cmd.env(k, v);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Speedy");
        // Keeps `pwd` showing the folder as given (e.g. /var vs /private/var on macOS).
        cmd.env("PWD", &spec.cwd);

        let mut child = pair.slave.spawn_command(cmd).with_context(|| format!("spawning {}", spec.shell))?;
        drop(pair.slave); // only the shell holds the slave, so EOF follows its exit
        let pid = child.process_id().ok_or_else(|| anyhow!("shell has no pid"))? as i32;
        let mut reader = pair.master.try_clone_reader().context("pty reader")?;
        let mut writer = pair.master.take_writer().context("pty writer")?;
        let sink = Arc::new(Mutex::new(sink));

        // Reader: blocking reads, handed to the coalescer (bounded, so a slow
        // consumer back-pressures the shell instead of growing memory).
        let (chunk_tx, chunk_rx) = mpsc::sync_channel::<Vec<u8>>(64);
        std::thread::Builder::new().name(format!("pty-read-{pid}")).spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if chunk_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break, // EIO once the slave side is closed
                }
            }
        })?;

        // Coalescer: flush on tick or size cap; signals `drained` at EOF.
        let (drained_tx, drained_rx) = mpsc::channel::<()>();
        let out = sink.clone();
        std::thread::Builder::new().name(format!("pty-out-{pid}")).spawn(move || {
            let mut c = Coalescer::default();
            let emit = |frame: Option<Vec<u8>>| {
                if let Some(frame) = frame {
                    (out.lock())(frame);
                }
            };
            loop {
                let next = match c.deadline() {
                    Some(due) => chunk_rx.recv_timeout(due.saturating_duration_since(Instant::now())),
                    None => chunk_rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match next {
                    Ok(chunk) => emit(c.push(&chunk, Instant::now())),
                    Err(RecvTimeoutError::Timeout) => emit(c.poll(Instant::now())),
                    Err(RecvTimeoutError::Disconnected) => {
                        emit(c.flush());
                        break;
                    }
                }
            }
            let _ = drained_tx.send(());
        })?;

        // Writer: ordered, off the caller's thread (a full PTY input buffer
        // must not block IPC handlers).
        let (input, input_rx) = mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new().name(format!("pty-write-{pid}")).spawn(move || {
            while let Ok(data) = input_rx.recv() {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        })?;

        // Waiter: reaps the shell, lets the final output drain, reports the exit.
        std::thread::Builder::new().name(format!("pty-wait-{pid}")).spawn(move || {
            let code = match child.wait() {
                Ok(status) if status.signal().is_none() => Some(status.exit_code() as i32),
                _ => None,
            };
            let _ = drained_rx.recv_timeout(DRAIN_AFTER_EXIT);
            on_exit(code);
        })?;

        Ok(PtySession { master: Mutex::new(pair.master), input, sink, pid })
    }

    /// Routes future output to `sink` (e.g. a new channel after a webview reload).
    pub fn set_sink(&self, sink: OutputSink) {
        *self.sink.lock() = sink;
    }

    pub fn write(&self, data: &[u8]) {
        let _ = self.input.send(data.to_vec());
    }

    /// Sets the PTY window size; the kernel delivers SIGWINCH to the foreground group.
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.lock().resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
    }

    pub fn pid(&self) -> i32 {
        self.pid
    }

    fn foreground_group(&self) -> Option<i32> {
        self.master.lock().process_group_leader()
    }

    /// True when a job other than the shell owns the terminal (e.g. `npm run dev`).
    pub fn has_foreground_child(&self) -> bool {
        self.foreground_group().is_some_and(|pg| pg != self.pid)
    }

    /// The shell's group plus the terminal's foreground job group, which job
    /// control puts in a group of its own.
    fn process_groups(&self) -> Vec<i32> {
        let mut groups = vec![self.pid];
        if let Some(pg) = self.foreground_group().filter(|pg| *pg != self.pid) {
            groups.push(pg);
        }
        groups
    }
}

/// SIGHUP every group, wait up to `grace` for them to go, SIGKILL survivors (KTD9).
fn hangup_then_kill(groups: &[i32], grace: Duration) {
    for &pg in groups {
        proc_group::signal_group(pg, libc::SIGHUP);
    }
    proc_group::reap_groups_blocking(groups, grace);
}

struct Entry {
    id: u64,
    session: Arc<PtySession>,
}

type Sessions = Arc<Mutex<HashMap<String, Entry>>>;

/// Terminal id → PTY session. Reports exits through `on_exit` and forgets the session.
pub struct PtyHost {
    sessions: Sessions,
    on_exit: Arc<dyn Fn(PtyExit) + Send + Sync>,
    next_id: AtomicU64,
}

impl PtyHost {
    pub fn new(on_exit: impl Fn(PtyExit) + Send + Sync + 'static) -> Self {
        PtyHost { sessions: Arc::default(), on_exit: Arc::new(on_exit), next_id: AtomicU64::new(1) }
    }

    /// Starts the terminal's shell, or rebinds output (and size) if it already runs.
    pub fn open(&self, terminal_id: &str, spec: PtySpawn, sink: OutputSink) -> anyhow::Result<()> {
        // Held across spawn so an instant exit can't run before the insert.
        let mut sessions = self.sessions.lock();
        if let Some(entry) = sessions.get(terminal_id) {
            entry.session.set_sink(sink);
            return entry.session.resize(spec.cols, spec.rows);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let session = PtySession::spawn(spec, sink, self.exit_callback(terminal_id, id))?;
        sessions.insert(terminal_id.to_string(), Entry { id, session: Arc::new(session) });
        Ok(())
    }

    fn exit_callback(&self, terminal_id: &str, id: u64) -> ExitCallback {
        let sessions: Weak<Mutex<HashMap<String, Entry>>> = Arc::downgrade(&self.sessions);
        let emit = self.on_exit.clone();
        let terminal_id = terminal_id.to_string();
        Box::new(move |code| {
            if let Some(sessions) = sessions.upgrade() {
                let mut map = sessions.lock();
                if map.get(&terminal_id).is_some_and(|e| e.id == id) {
                    map.remove(&terminal_id);
                }
            }
            emit(PtyExit { terminal_id, code });
        })
    }

    fn get(&self, terminal_id: &str) -> anyhow::Result<Arc<PtySession>> {
        self.sessions
            .lock()
            .get(terminal_id)
            .map(|e| e.session.clone())
            .ok_or_else(|| anyhow!("no terminal {terminal_id}"))
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> anyhow::Result<()> {
        self.get(terminal_id)?.write(data);
        Ok(())
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.get(terminal_id)?.resize(cols, rows)
    }

    /// Forgets the session now and tears its process groups down in the background.
    pub fn close(&self, terminal_id: &str, grace: Duration) {
        let Some(entry) = self.sessions.lock().remove(terminal_id) else { return };
        let groups = entry.session.process_groups();
        let _ = std::thread::Builder::new().name("pty-close".into()).spawn(move || {
            hangup_then_kill(&groups, grace);
            drop(entry);
        });
    }

    pub fn contains(&self, terminal_id: &str) -> bool {
        self.sessions.lock().contains_key(terminal_id)
    }

    pub fn has_foreground_child(&self, terminal_id: &str) -> bool {
        self.get(terminal_id).is_ok_and(|s| s.has_foreground_child())
    }

    /// Synchronous quit path: SIGHUP every group, wait up to `grace`, SIGKILL survivors.
    /// Takes the sessions out first so exit callbacks never contend with the wait.
    pub fn shutdown_all(&self, grace: Duration) {
        let entries: Vec<Entry> = self.sessions.lock().drain().map(|(_, e)| e).collect();
        let groups: Vec<i32> = entries.iter().flat_map(|e| e.session.process_groups()).collect();
        if !groups.is_empty() {
            hangup_then_kill(&groups, grace);
        }
    }
}

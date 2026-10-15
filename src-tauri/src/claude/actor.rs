//! U3: per-thread session actor (KTD4, KTD5, KTD9).
//!
//! One actor owns one `claude` child at a time (it respawns across crashes) and
//! its stdin/stdout/stderr. Stdout is drained continuously on its own task and
//! every non-control line goes to the event sink verbatim. Everything here runs
//! without Tauri: the sink is a plain callback, so tests drive it directly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use super::diff::{self, FileDiff};
use super::process;
use super::protocol::{self, LineSplitter};
use super::{ClaudeEvent, PermissionOutcome, StartOptions, ThreadStatus};

pub type EventSink = Arc<dyn Fn(ClaudeEvent) + Send + Sync>;
/// Called on every status transition with `(from, to)`.
pub type StatusObserver = Arc<dyn Fn(ThreadStatus, ThreadStatus) + Send + Sync>;

pub const DEFAULT_CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
/// A crash this soon after the automatic respawn waits for a manual retry.
pub const CRASH_WINDOW: Duration = Duration::from_secs(30);
const STDERR_TAIL_BYTES: usize = 8 * 1024;
const READ_CHUNK: usize = 64 * 1024;
const STDERR_CHUNK: usize = 4 * 1024;

/// Everything needed to launch the CLI for one thread.
pub struct ActorConfig {
    pub program: PathBuf,
    pub options: StartOptions,
    /// Resolved login-shell env, overlaid on the inherited env.
    pub env: HashMap<String, String>,
    /// Effective `claudeCode.*` settings (skip-permissions parity, extra env vars).
    pub extension_settings: Map<String, Value>,
}

#[derive(Clone)]
pub struct ClaudeActor {
    inner: Arc<Inner>,
}

struct Inner {
    program: PathBuf,
    env: HashMap<String, String>,
    settings: Map<String, Value>,
    runtime: Handle,
    on_status: StatusObserver,
    out: Mutex<Out>,
    state: Mutex<State>,
}

struct Out {
    seq: u64,
    sink: EventSink,
}

struct State {
    options: StartOptions,
    status: ThreadStatus,
    session_id: Option<String>,
    /// Bumped on every launch; output and exits from older children are ignored.
    generation: u64,
    /// Process group of the live child.
    running: Option<i32>,
    stdin: Option<Arc<tokio::sync::Mutex<ChildStdin>>>,
    /// Set by stop/quit so the exit is not treated as a crash.
    stopping: bool,
    auto_respawned_at: Option<Instant>,
    pending_permissions: HashMap<String, PendingPermission>,
    pending_controls: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    stderr_tail: Vec<u8>,
}

struct PendingPermission {
    tool_name: String,
    input: Value,
    diff: Option<Vec<FileDiff>>,
}

impl ClaudeActor {
    /// Spawns the CLI and sends `initialize`. Must be called inside a tokio runtime.
    pub fn start(config: ActorConfig, sink: EventSink, on_status: StatusObserver) -> ClaudeActor {
        let resume = config.options.resume_session_id.clone();
        let inner = Arc::new(Inner {
            program: config.program,
            env: config.env,
            settings: config.extension_settings,
            runtime: Handle::current(),
            on_status,
            out: Mutex::new(Out { seq: 0, sink }),
            state: Mutex::new(State {
                options: config.options,
                status: ThreadStatus::NotStarted,
                session_id: None,
                generation: 0,
                running: None,
                stdin: None,
                stopping: false,
                auto_respawned_at: None,
                pending_permissions: HashMap::new(),
                pending_controls: HashMap::new(),
                stderr_tail: Vec::new(),
            }),
        });
        inner.launch(resume, false);
        ClaudeActor { inner }
    }

    pub fn status(&self) -> ThreadStatus {
        self.inner.state.lock().status
    }

    /// Routes all further events to `sink` (webview reload). Seq continues.
    pub fn rebind(&self, sink: EventSink) {
        self.inner.out.lock().sink = sink;
    }

    /// Writes a user message; `content` is an Anthropic content-block array.
    pub async fn send_user(&self, content: Value) -> Result<(), String> {
        {
            let mut st = self.inner.state.lock();
            if st.stdin.is_none() {
                return Err(NOT_RUNNING.into());
            }
            // Before the write, so a fast `result` can't be overtaken.
            if matches!(st.status, ThreadStatus::Idle | ThreadStatus::Starting) {
                self.inner.set_status(&mut st, ThreadStatus::Working, None, None, false);
            }
        }
        self.inner.write(&protocol::user_message(content)).await
    }

    /// Sends a control request and resolves with the CLI's response payload.
    pub async fn control(&self, request: Value, timeout: Option<Duration>) -> Result<Value, String> {
        self.inner.control(request, timeout.unwrap_or(DEFAULT_CONTROL_TIMEOUT)).await
    }

    /// Answers a pending `can_use_tool` request. An allow on a request whose
    /// diff went stale sends nothing and returns the refreshed diff (KTD5).
    pub async fn respond_permission(&self, request_id: &str, response: Value) -> Result<PermissionOutcome, String> {
        let inner = &self.inner;
        let (tool_name, input, shown, cwd) = {
            let st = inner.state.lock();
            let p = st
                .pending_permissions
                .get(request_id)
                .ok_or_else(|| format!("no pending permission request {request_id}"))?;
            (p.tool_name.clone(), p.input.clone(), p.diff.clone(), st.options.cwd.clone())
        };
        if response["behavior"] == "allow"
            && let Some(shown) = shown
            && let Some(fresh) = diff::refresh_if_stale(&tool_name, &input, Path::new(&cwd), &shown)
        {
            if let Some(p) = inner.state.lock().pending_permissions.get_mut(request_id) {
                p.diff = Some(fresh.clone());
            }
            return Ok(PermissionOutcome { sent: false, refreshed_diff: Some(fresh) });
        }
        {
            let mut st = inner.state.lock();
            st.pending_permissions.remove(request_id);
            inner.resume_working_if_answered(&mut st);
        }
        inner.write(&protocol::control_success(request_id, response)).await?;
        Ok(PermissionOutcome { sent: true, refreshed_diff: None })
    }

    /// Denies every pending permission request, then sends `interrupt` (KTD5).
    /// Status returns to Idle when the turn's `result` arrives.
    pub async fn interrupt(&self) -> Result<(), String> {
        let denied = {
            let mut st = self.inner.state.lock();
            let ids = self.inner.resolve_pending(&mut st, "interrupted");
            self.inner.resume_working_if_answered(&mut st);
            ids
        };
        for id in denied {
            self.inner.write(&deny(&id, "Interrupted by user")).await?;
        }
        self.inner.control(json!({"subtype": "interrupt"}), DEFAULT_CONTROL_TIMEOUT).await.map(|_| ())
    }

    /// Thread closed: SIGTERM the process group, SIGKILL whatever survives `grace`.
    pub async fn stop(&self, grace: Duration) {
        let pgid = {
            let mut st = self.inner.state.lock();
            st.stopping = true;
            st.stdin = None;
            st.pending_controls.clear();
            st.pending_permissions.clear();
            self.inner.set_status(&mut st, ThreadStatus::Stopped, None, None, false);
            st.running.take()
        };
        if let Some(pgid) = pgid {
            process::signal_group(pgid, libc::SIGTERM);
            process::reap_group(pgid, grace).await;
        }
    }

    /// Manual retry after Crashed/Errored, resuming the bound session when known.
    /// Any other status is returned unchanged.
    pub fn retry(&self) -> ThreadStatus {
        let resume = {
            let mut st = self.inner.state.lock();
            if !matches!(st.status, ThreadStatus::Crashed | ThreadStatus::Errored) {
                return st.status;
            }
            st.auto_respawned_at = None;
            st.session_id.clone().or_else(|| st.options.resume_session_id.clone())
        };
        self.inner.launch(resume, false);
        self.status()
    }

    /// Relaunches a Stopped actor with new options (thread reopened). Seq continues.
    pub fn restart(&self, options: StartOptions) -> ThreadStatus {
        let resume = options.resume_session_id.clone();
        {
            let mut st = self.inner.state.lock();
            st.options = options;
            st.auto_respawned_at = None;
        }
        self.inner.launch(resume, false);
        self.status()
    }
}

/// KTD9 quit sequence, blocking: deny pending requests, interrupt running turns,
/// SIGTERM every process group, wait up to `grace`, SIGKILL survivors. The
/// writes run on each actor's runtime, so this is safe to call from a thread
/// that is not driving that runtime (e.g. the Tauri run loop).
pub fn shutdown_all(actors: &[ClaudeActor], grace: Duration) {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let mut pgids = vec![];
    for actor in actors {
        let inner = actor.inner.clone();
        let (pgid, lines) = inner.begin_shutdown();
        pgids.extend(pgid);
        let done = done_tx.clone();
        actor.inner.runtime.spawn(async move {
            for line in lines {
                if inner.write(&line).await.is_err() {
                    break;
                }
            }
            let _ = done.send(());
        });
    }
    drop(done_tx);
    let deadline = Instant::now() + grace;
    for _ in actors {
        if done_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() {
            break;
        }
    }
    for &pgid in &pgids {
        process::signal_group(pgid, libc::SIGTERM);
    }
    process::reap_groups_blocking(&pgids, grace);
}

const NOT_RUNNING: &str = "claude process is not running";

fn deny(request_id: &str, message: &str) -> Value {
    protocol::control_success(request_id, json!({"behavior": "deny", "message": message}))
}

impl Inner {
    fn emit(&self, make: impl FnOnce(u64) -> ClaudeEvent) {
        let mut out = self.out.lock();
        out.seq += 1;
        let event = make(out.seq);
        (out.sink)(event);
    }

    fn set_status(
        &self,
        st: &mut State,
        to: ThreadStatus,
        detail: Option<String>,
        stderr_tail: Option<String>,
        reconnecting: bool,
    ) {
        let from = st.status;
        if from == to {
            return;
        }
        st.status = to;
        self.emit(|seq| ClaudeEvent::Status { seq, status: to, detail, stderr_tail, reconnecting });
        (self.on_status)(from, to);
    }

    fn resume_working_if_answered(&self, st: &mut State) {
        if st.pending_permissions.is_empty() && st.status == ThreadStatus::AwaitingUser {
            self.set_status(st, ThreadStatus::Working, None, None, false);
        }
    }

    /// Drops every pending permission request, telling the UI why.
    fn resolve_pending(&self, st: &mut State, reason: &str) -> Vec<String> {
        let ids: Vec<String> = st.pending_permissions.drain().map(|(id, _)| id).collect();
        for id in &ids {
            self.emit(|seq| ClaudeEvent::PermissionResolved { seq, request_id: id.clone(), reason: reason.into() });
        }
        ids
    }

    fn stderr_tail(st: &State) -> String {
        String::from_utf8_lossy(&st.stderr_tail).into_owned()
    }

    fn launch(self: &Arc<Self>, resume: Option<String>, reconnecting: bool) {
        let _rt = self.runtime.enter();
        let (generation, args, env, cwd) = {
            let mut st = self.state.lock();
            // A child still alive here (e.g. Errored after a failed initialize) is superseded.
            if let Some(old) = st.running.take() {
                process::signal_group(old, libc::SIGKILL);
            }
            st.generation += 1;
            st.stopping = false;
            st.stdin = None;
            st.stderr_tail.clear();
            self.set_status(&mut st, ThreadStatus::Starting, None, None, reconnecting);
            let args = process::build_args(&st.options, resume.as_deref(), &self.settings);
            (st.generation, args, process::build_env(&self.env, &self.settings), PathBuf::from(&st.options.cwd))
        };

        let mut child = match process::spawn(&self.program, &args, &cwd, &env) {
            Ok(child) => child,
            Err(e) => {
                let mut st = self.state.lock();
                if st.generation == generation {
                    let detail = format!("failed to start {}: {e}", self.program.display());
                    self.set_status(&mut st, ThreadStatus::Errored, Some(detail), None, false);
                }
                return;
            }
        };
        let (Some(stdin), Some(stdout), Some(stderr), Some(pid)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take(), child.id())
        else {
            unreachable!("stdio is piped and the child was just spawned");
        };
        {
            let mut st = self.state.lock();
            st.running = Some(pid as i32);
            st.stdin = Some(Arc::new(tokio::sync::Mutex::new(stdin)));
        }

        let me = self.clone();
        let stdout_task = tokio::spawn(async move { me.read_stdout(generation, stdout).await });
        let me = self.clone();
        let stderr_task = tokio::spawn(async move { me.read_stderr(generation, stderr).await });
        let me = self.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            // Lines written just before exit are handled before the exit itself.
            let _ = tokio::time::timeout(Duration::from_secs(2), stdout_task).await;
            let _ = tokio::time::timeout(Duration::from_millis(500), stderr_task).await;
            me.handle_exit(generation, status);
        });
        let me = self.clone();
        tokio::spawn(async move { me.initialize(generation).await });
    }

    async fn initialize(&self, generation: u64) {
        let result = self.control(json!({"subtype": "initialize"}), DEFAULT_CONTROL_TIMEOUT).await;
        let mut st = self.state.lock();
        if st.generation != generation {
            return;
        }
        match result {
            Ok(response) => {
                self.emit(|seq| ClaudeEvent::Initialized { seq, response });
                if st.status == ThreadStatus::Starting {
                    self.set_status(&mut st, ThreadStatus::Idle, None, None, false);
                }
            }
            Err(e) => {
                if st.status == ThreadStatus::Starting && st.running.is_some() {
                    let tail = Self::stderr_tail(&st);
                    self.set_status(&mut st, ThreadStatus::Errored, Some(format!("initialize failed: {e}")), Some(tail), false);
                }
            }
        }
    }

    async fn read_stdout(self: &Arc<Self>, generation: u64, mut stdout: impl AsyncRead + Unpin) {
        let mut buf = vec![0u8; READ_CHUNK];
        let mut lines = LineSplitter::default();
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => lines.push(&buf[..n], |line| self.handle_line(generation, line)),
            }
        }
        if let Some(rest) = lines.finish() {
            self.handle_line(generation, &rest);
        }
    }

    async fn read_stderr(&self, generation: u64, mut stderr: impl AsyncRead + Unpin) {
        let mut buf = vec![0u8; STDERR_CHUNK];
        loop {
            let n = match stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut st = self.state.lock();
            if st.generation != generation {
                continue;
            }
            st.stderr_tail.extend_from_slice(&buf[..n]);
            let excess = st.stderr_tail.len().saturating_sub(STDERR_TAIL_BYTES);
            st.stderr_tail.drain(..excess);
            let text = String::from_utf8_lossy(&buf[..n]).into_owned();
            self.emit(|seq| ClaudeEvent::Stderr { seq, text });
        }
    }

    fn handle_line(self: &Arc<Self>, generation: u64, line: &[u8]) {
        if line.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        let mut msg: Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => {
                let line = String::from_utf8_lossy(line).into_owned();
                if self.state.lock().generation == generation {
                    self.emit(|seq| ClaudeEvent::ProtocolError { seq, line });
                }
                return;
            }
        };
        let env = protocol::envelope(&msg);
        let request_id = env.request_id.map(str::to_owned);
        match env.kind {
            Some("control_response") => {
                let tx = request_id.and_then(|id| self.state.lock().pending_controls.remove(&id));
                if let Some(tx) = tx {
                    let _ = tx.send(protocol::control_response_result(&msg));
                }
            }
            Some("control_request") => {
                let id = request_id.unwrap_or_default();
                if env.request_subtype == Some("can_use_tool") {
                    let request = msg["request"].take();
                    self.on_permission_request(generation, id, request);
                } else {
                    // No hooks or SDK MCP servers are registered; never leave the CLI waiting.
                    let error = format!("unsupported control request: {}", env.request_subtype.unwrap_or("unknown"));
                    let me = self.clone();
                    let reply = protocol::control_error(&id, &error);
                    self.runtime.spawn(async move {
                        let _ = me.write(&reply).await;
                    });
                }
            }
            Some("control_cancel_request") => {
                let mut st = self.state.lock();
                if st.generation == generation
                    && let Some(id) = request_id
                    && st.pending_permissions.remove(&id).is_some()
                {
                    self.emit(|seq| ClaudeEvent::PermissionResolved { seq, request_id: id, reason: "cancelled".into() });
                    self.resume_working_if_answered(&mut st);
                }
            }
            kind => {
                let is_result = kind == Some("result");
                let bound = (kind == Some("system") && env.subtype == Some("init"))
                    .then(|| env.session_id.map(str::to_owned))
                    .flatten();
                let mut st = self.state.lock();
                if st.generation != generation {
                    return;
                }
                if let Some(session_id) = bound
                    && st.session_id.as_deref() != Some(session_id.as_str())
                {
                    st.session_id = Some(session_id.clone());
                    self.emit(|seq| ClaudeEvent::SessionBound { seq, session_id });
                }
                self.emit(|seq| ClaudeEvent::Message { seq, raw: msg });
                if is_result && matches!(st.status, ThreadStatus::Working | ThreadStatus::AwaitingUser) {
                    self.set_status(&mut st, ThreadStatus::Idle, None, None, false);
                }
            }
        }
    }

    fn on_permission_request(&self, generation: u64, request_id: String, request: Value) {
        let cwd = PathBuf::from(&self.state.lock().options.cwd);
        let tool_name = request["tool_name"].as_str().unwrap_or_default().to_owned();
        let input = request.get("input").cloned().unwrap_or(Value::Null);
        let diff = diff::diff_for_tool(&tool_name, &input, &cwd);
        let mut st = self.state.lock();
        if st.generation != generation {
            return;
        }
        st.pending_permissions
            .insert(request_id.clone(), PendingPermission { tool_name, input, diff: diff.clone() });
        self.set_status(&mut st, ThreadStatus::AwaitingUser, None, None, false);
        self.emit(|seq| ClaudeEvent::PermissionRequest { seq, request_id, request, diff });
    }

    fn handle_exit(self: &Arc<Self>, generation: u64, status: std::io::Result<ExitStatus>) {
        let resume = {
            let mut st = self.state.lock();
            if st.generation != generation {
                return;
            }
            st.running = None;
            st.stdin = None;
            // Dropping the senders fails every in-flight control request.
            st.pending_controls.clear();
            if st.stopping {
                return;
            }
            self.resolve_pending(&mut st, "exited");
            let detail = match status {
                Ok(s) => match (s.code(), std::os::unix::process::ExitStatusExt::signal(&s)) {
                    (Some(code), _) => format!("claude exited with code {code}"),
                    (None, Some(sig)) => format!("claude was killed by signal {sig}"),
                    _ => "claude exited".to_owned(),
                },
                Err(e) => format!("lost track of claude: {e}"),
            };
            let tail = Self::stderr_tail(&st);
            self.set_status(&mut st, ThreadStatus::Crashed, Some(detail), Some(tail), false);
            if st.auto_respawned_at.is_some_and(|t| t.elapsed() < CRASH_WINDOW) {
                return;
            }
            st.auto_respawned_at = Some(Instant::now());
            st.session_id.clone().or_else(|| st.options.resume_session_id.clone())
        };
        self.launch(resume, true);
    }

    /// Marks the actor stopped for quit and returns its process group plus the
    /// lines to write first: a deny per pending request and, mid-turn, an interrupt.
    fn begin_shutdown(&self) -> (Option<i32>, Vec<Value>) {
        let mut st = self.state.lock();
        st.stopping = true;
        let mut lines: Vec<Value> =
            self.resolve_pending(&mut st, "quit").iter().map(|id| deny(id, "Speedy is quitting")).collect();
        if matches!(st.status, ThreadStatus::Working | ThreadStatus::AwaitingUser) {
            let id = uuid::Uuid::new_v4().to_string();
            lines.push(protocol::control_request(&id, json!({"subtype": "interrupt"})));
        }
        st.pending_controls.clear();
        self.set_status(&mut st, ThreadStatus::Stopped, None, None, false);
        (st.running.take(), lines)
    }

    async fn control(&self, request: Value, timeout: Duration) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let subtype = request["subtype"].as_str().unwrap_or("unknown").to_owned();
        let (tx, rx) = oneshot::channel();
        self.state.lock().pending_controls.insert(id.clone(), tx);
        if let Err(e) = self.write(&protocol::control_request(&id, request)).await {
            self.state.lock().pending_controls.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("claude process exited before answering {subtype}")),
            Err(_) => {
                self.state.lock().pending_controls.remove(&id);
                Err(format!("control request {subtype} timed out after {} ms", timeout.as_millis()))
            }
        }
    }

    async fn write(&self, msg: &Value) -> Result<(), String> {
        let stdin = self.state.lock().stdin.clone().ok_or(NOT_RUNNING)?;
        let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut w = stdin.lock().await;
        w.write_all(&line).await.map_err(|e| format!("writing to claude failed: {e}"))?;
        w.flush().await.map_err(|e| format!("writing to claude failed: {e}"))
    }
}

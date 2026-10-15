//! U4 PTY manager against a real login zsh. `ZDOTDIR` points at an empty dir so
//! the user's own dotfiles don't affect timing or output.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use speedy_lib::pty::PtyExit;
use speedy_lib::pty::coalesce::{SIZE_CAP, TICK};
use speedy_lib::pty::manager::{PtyHost, PtySpawn};

const WAIT: Duration = Duration::from_secs(15);

type FrameLog = Arc<Mutex<Vec<(Instant, Vec<u8>)>>>;

#[derive(Default, Clone)]
struct Frames(FrameLog);

impl Frames {
    fn sink(&self) -> Box<dyn FnMut(Vec<u8>) + Send> {
        let frames = self.0.clone();
        Box::new(move |bytes| frames.lock().unwrap().push((Instant::now(), bytes)))
    }
    fn text(&self) -> String {
        let bytes: Vec<u8> = self.0.lock().unwrap().iter().flat_map(|(_, b)| b.clone()).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
    fn sizes(&self) -> Vec<usize> {
        self.0.lock().unwrap().iter().map(|(_, b)| b.len()).collect()
    }
    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
    /// Waits for `marker` followed by a pid in the output (skipping the echoed command).
    fn wait_for_pid(&self, marker: &str) -> i32 {
        let start = Instant::now();
        loop {
            let text = self.text();
            let found = text.split(marker).skip(1).find_map(|rest| {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if rest[digits.len()..].starts_with('\r') { digits.parse().ok() } else { None }
            });
            if let Some(pid) = found {
                return pid;
            }
            assert!(start.elapsed() < WAIT, "timed out waiting for {marker:?}; got:\n{text}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_for(&self, needle: &str) {
        let start = Instant::now();
        while !self.text().contains(needle) {
            assert!(start.elapsed() < WAIT, "timed out waiting for {needle:?}; got:\n{}", self.text());
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

struct Fixture {
    host: PtyHost,
    exits: Arc<Mutex<Vec<PtyExit>>>,
    zdotdir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let exits = Arc::new(Mutex::new(Vec::new()));
    let sink = exits.clone();
    let host = PtyHost::new(move |e| sink.lock().unwrap().push(e));
    Fixture { host, exits, zdotdir: tempfile::tempdir().unwrap() }
}

impl Fixture {
    fn spec(&self, cwd: &Path) -> PtySpawn {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.insert("ZDOTDIR".into(), self.zdotdir.path().to_string_lossy().into_owned());
        PtySpawn { shell: "/bin/zsh".into(), cwd: cwd.to_path_buf(), env, cols: 80, rows: 24 }
    }

    /// Opens a shell for `id` and waits until it runs commands.
    fn open(&self, id: &str, cwd: &Path) -> Frames {
        let frames = Frames::default();
        self.host.open(id, self.spec(cwd), frames.sink()).unwrap();
        self.host.write(id, b"echo READY_$((40+2))\n").unwrap();
        frames.wait_for("READY_42");
        frames
    }
}

fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let start = Instant::now();
    while !cond() {
        assert!(start.elapsed() < WAIT, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn process_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn project_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    (dir, path)
}

#[test]
fn shell_starts_in_the_project_folder_with_terminal_env() {
    let f = fixture();
    let (_keep, project) = project_dir();
    let frames = f.open("t-pwd", &project);
    f.host.write("t-pwd", b"pwd\n").unwrap();
    frames.wait_for(&format!("\r\n{}\r\n", project.display()));
    f.host.write("t-pwd", b"echo \"$TERM|$COLORTERM|$TERM_PROGRAM\"\n").unwrap();
    frames.wait_for("\r\nxterm-256color|truecolor|Speedy\r\n");
    f.host.shutdown_all(Duration::from_secs(1));
}

#[test]
fn ten_megabytes_of_output_arrive_complete_and_in_order() {
    let f = fixture();
    let (_keep, dir) = project_dir();
    let frames = f.open("t-bulk", &dir);
    let n = 1_300_000u32;
    f.host.write("t-bulk", format!("awk 'BEGIN {{ for (i = 1; i <= {n}; i++) print i }}'; echo DONE_$((1+1))\n").as_bytes()).unwrap();
    frames.wait_for("\r\nDONE_2");

    let text = frames.text();
    let first = text.find("\r\n1\r\n").expect("seq output starts") + 2;
    let end = text.rfind("\r\nDONE_2").unwrap();
    let body = &text[first..end];
    assert!(body.len() >= 10 * 1024 * 1024, "only {} bytes", body.len());
    let mut expected = 1u32;
    for line in body.split("\r\n") {
        assert_eq!(line, expected.to_string(), "line out of order or corrupted");
        expected += 1;
    }
    assert_eq!(expected, n + 1);

    let sizes = frames.sizes();
    assert!(sizes.len() > 100, "expected many coalesced frames, got {}", sizes.len());
    assert!(sizes.iter().all(|&s| s < 2 * SIZE_CAP), "a frame exceeded the size cap");
    f.host.shutdown_all(Duration::from_secs(1));
}

#[test]
fn small_echo_flushes_within_a_tick() {
    let f = fixture();
    let (_keep, dir) = project_dir();
    let frames = f.open("t-echo", &dir);
    std::thread::sleep(Duration::from_millis(100)); // let the prompt settle
    let before = frames.count();
    let sent = Instant::now();
    f.host.write("t-echo", b"x").unwrap();
    wait_until("echo frame", || frames.0.lock().unwrap()[before..].iter().any(|(_, b)| b.contains(&b'x')));
    let (at, bytes) = frames.0.lock().unwrap()[before..].iter().find(|(_, b)| b.contains(&b'x')).cloned().unwrap();
    let latency = at - sent;
    assert!(bytes.len() < SIZE_CAP, "echo should not wait for the size cap");
    assert!(latency < TICK * 4, "echo took {latency:?}");
    f.host.shutdown_all(Duration::from_secs(1));
}

#[test]
fn resize_reaches_the_shell() {
    let f = fixture();
    let (_keep, dir) = project_dir();
    let frames = f.open("t-size", &dir);
    f.host.resize("t-size", 120, 40).unwrap();
    f.host.write("t-size", b"stty size\n").unwrap();
    frames.wait_for("\r\n40 120\r\n");
    f.host.shutdown_all(Duration::from_secs(1));
}

#[test]
fn exit_emits_one_event_with_code_zero_and_frees_the_pty() {
    let f = fixture();
    let (_keep, dir) = project_dir();
    let _frames = f.open("t-exit", &dir);
    assert!(f.host.contains("t-exit"));
    f.host.write("t-exit", b"exit\n").unwrap();
    wait_until("exit event", || !f.exits.lock().unwrap().is_empty());
    std::thread::sleep(Duration::from_millis(300));
    let exits = f.exits.lock().unwrap().clone();
    assert_eq!(exits.len(), 1, "{exits:?}");
    assert_eq!(exits[0].thread_id, "t-exit");
    assert_eq!(exits[0].code, Some(0));
    assert!(!f.host.contains("t-exit"));
    assert!(f.host.write("t-exit", b"x").is_err());
}

#[test]
fn close_terminates_a_running_foreground_child() {
    let f = fixture();
    let (_keep, dir) = project_dir();
    let frames = f.open("t-close", &dir);
    assert!(!f.host.has_foreground_child("t-close"), "idle shell has no foreground child");
    f.host.write("t-close", b"sh -c 'echo CHILD=$$; exec sleep 1000'\n").unwrap();
    let pid = frames.wait_for_pid("CHILD=");
    wait_until("foreground child", || f.host.has_foreground_child("t-close"));
    assert!(process_alive(pid));

    let started = Instant::now();
    f.host.close("t-close", Duration::from_secs(2));
    assert!(started.elapsed() < Duration::from_millis(100), "close must not block the caller");
    assert!(!f.host.contains("t-close"));
    wait_until("sleep 1000 to die", || !process_alive(pid));
}

#[test]
fn shutdown_all_kills_children_that_ignore_sighup() {
    let f = fixture();
    let (_keep, dir) = project_dir();
    let frames = f.open("t-quit", &dir);
    f.host.write("t-quit", b"sh -c 'trap \"\" HUP; echo STUBBORN=$$; while :; do sleep 1; done'\n").unwrap();
    let pid = frames.wait_for_pid("STUBBORN=");
    wait_until("foreground child", || f.host.has_foreground_child("t-quit"));

    let started = Instant::now();
    f.host.shutdown_all(Duration::from_millis(500));
    assert!(started.elapsed() < Duration::from_secs(3), "shutdown_all must respect its grace");
    assert!(!f.host.contains("t-quit"));
    wait_until("HUP-ignoring child to be killed", || !process_alive(pid));
}

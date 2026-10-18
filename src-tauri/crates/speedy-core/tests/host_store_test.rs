//! U5: the host owns thread behavior (KTD6). Driven against `tests/fixtures/fake-claude`
//! with no subscriber attached, as when every client is disconnected.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use speedy_core::claude::ThreadStatus;
use speedy_core::host::log::Cursor;
use speedy_core::host::{Host, HostPaths, Launch, LaunchFn, NewProject, NewThread, ThreadReplay};
use tokio::sync::mpsc::UnboundedReceiver;

const WAIT: Duration = Duration::from_secs(10);

/// Answers our `initialize` control_request, then reports a session id.
const INIT: &str = r#"expect "subtype":"initialize"
emit {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"commands":[],"pid":1}}}
emit {"type":"system","subtype":"init","session_id":"sess-1","slash_commands":[]}"#;

struct Fixture {
    dir: tempfile::TempDir,
    log: PathBuf,
    project: PathBuf,
    scenario: PathBuf,
}

impl Fixture {
    fn new(scenarios: &[&str]) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let project = dir.path().join("project");
        std::fs::create_dir_all(&log).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let scenario = dir.path().join("scenario");
        for (i, s) in scenarios.iter().enumerate() {
            std::fs::write(format!("{}.{}", scenario.display(), i + 1), format!("{s}\n")).unwrap();
        }
        Fixture { dir, log, project, scenario }
    }

    fn paths(&self) -> HostPaths {
        HostPaths {
            state_dir: self.dir.path().join("state"),
            chats_dir: self.dir.path().join("chats"),
            worktrees_dir: self.dir.path().join("worktrees"),
        }
    }

    fn launch(&self) -> LaunchFn {
        let env = HashMap::from([
            ("FAKE_CLAUDE_LOG".to_string(), self.log.to_string_lossy().into_owned()),
            ("FAKE_CLAUDE_SCENARIO".to_string(), self.scenario.to_string_lossy().into_owned()),
            ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
        ]);
        let program = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-claude");
        Arc::new(move || {
            let launch = Launch { program: program.clone(), env: env.clone(), extension_settings: Map::new() };
            Box::pin(async move { Ok(launch) })
        })
    }

    fn open(&self) -> Arc<Host> {
        Host::open(self.paths(), self.launch())
    }

    /// A host with one project at `self.project` and one thread in it.
    fn open_with_thread(&self, worktree_requested: bool) -> Arc<Host> {
        let host = self.open();
        host.add_project(NewProject { id: "p1".into(), path: self.project.to_string_lossy().into_owned(), name: "proj".into() })
            .unwrap();
        host.create_thread("p1", NewThread { id: "t1".into(), worktree_requested, ..Default::default() }).unwrap();
        host
    }

    fn stdin(&self, launch: u32) -> Vec<Value> {
        std::fs::read_to_string(self.log.join(format!("stdin.{launch}")))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.log.join(name)).unwrap_or_default()
    }
}

fn text(s: &str) -> Value {
    json!([{"type": "text", "text": s}])
}

fn user_texts(stdin: &[Value]) -> Vec<String> {
    stdin
        .iter()
        .filter(|v| v["type"] == "user")
        .map(|v| v["message"]["content"][0]["text"].as_str().unwrap().to_owned())
        .collect()
}

async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn next(rx: &mut UnboundedReceiver<Arc<Value>>, kind: &str) -> Arc<Value> {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let event = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {kind}"))
            .expect("subscription open");
        if event["kind"] == kind {
            return event;
        }
    }
}

fn events(replay: ThreadReplay) -> Vec<Arc<Value>> {
    match replay {
        ThreadReplay::Events(events) => events,
        ThreadReplay::Snapshot(_) => panic!("expected events, got a snapshot"),
    }
}

/// Three turns, each answered after a pause so later messages arrive while Working.
fn three_turns() -> String {
    let mut s = format!("{INIT}\n");
    for msg in ["first", "second", "third", "fourth"] {
        s += &format!("expect \"{msg}\"\nsleep 0.3\nemit {{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}}\n");
    }
    s + "idle"
}

#[tokio::test(flavor = "multi_thread")]
async fn messages_queued_while_working_send_in_order_with_no_client_attached() {
    let fx = Fixture::new(&[&three_turns()]);
    let host = fx.open_with_thread(false);
    for msg in ["first", "second", "third", "fourth"] {
        host.send("t1", text(msg)).await.unwrap();
    }
    wait_until("all four turns", || user_texts(&fx.stdin(1)).len() == 4).await;
    assert_eq!(user_texts(&fx.stdin(1)), ["first", "second", "third", "fourth"]);
    wait_until("idle", || host.thread_status("t1") == Some(ThreadStatus::Idle)).await;

    // A client that connects afterwards sees every message the host sent and each queue change.
    let (replay, _rx) = host.subscribe_thread("t1", Some(Cursor { epoch: host.epoch(), seq: 0 })).unwrap();
    let log = events(replay);
    let sent: Vec<&str> =
        log.iter().filter(|e| e["kind"] == "user_sent").map(|e| e["content"][0]["text"].as_str().unwrap()).collect();
    assert_eq!(sent, ["first", "second", "third", "fourth"]);
    let queues: Vec<usize> =
        log.iter().filter(|e| e["kind"] == "queue_changed").map(|e| e["queue"].as_array().unwrap().len()).collect();
    assert!(queues.contains(&3) && queues.last() == Some(&0), "queue grew to 3 and drained: {queues:?}");
    let seqs: Vec<u64> = log.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "one increasing seq across host and actor events: {seqs:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_message_titles_a_new_thread() {
    let fx = Fixture::new(&[&format!("{INIT}\nidle")]);
    let host = fx.open_with_thread(false);
    host.send("t1", text("  fix   the flaky\nsidebar test  ")).await.unwrap();
    host.send("t1", text("and then something else")).await.unwrap();
    assert_eq!(host.thread("t1").unwrap().title, "fix the flaky sidebar test");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_with_a_stale_cursor_gets_a_snapshot_of_the_live_state() {
    let fx = Fixture::new(&[&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"perm-1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"ls"}}}}}}
idle"#
    )]);
    let host = fx.open_with_thread(false);
    host.send("t1", text("go")).await.unwrap();
    wait_until("prompt", || host.thread_status("t1") == Some(ThreadStatus::AwaitingUser)).await;

    let (replay, _rx) = host.subscribe_thread("t1", Some(Cursor { epoch: host.epoch() + 1, seq: 4 })).unwrap();
    let ThreadReplay::Snapshot(snap) = replay else { panic!("an old epoch needs a snapshot") };
    assert_eq!(snap.epoch, host.epoch());
    assert_eq!(snap.session_id.as_deref(), Some("sess-1"));
    let kinds: Vec<&str> = snap.events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"initialized"), "{kinds:?}");
    assert!(snap.events.iter().any(|e| e["kind"] == "permission_request" && e["request_id"] == "perm-1"));
    assert_eq!(snap.events.last().unwrap()["status"], "awaiting_user", "status comes last: {kinds:?}");

    // No cursor at all is the same as a stale one.
    assert!(matches!(host.subscribe_thread("t1", None).unwrap().0, ThreadReplay::Snapshot(_)));
}

#[tokio::test(flavor = "multi_thread")]
async fn every_subscriber_gets_live_events_and_dropping_one_leaves_the_other() {
    let fx = Fixture::new(&[&format!(
        "{INIT}\nexpect \"one\"\nemit {{\"type\":\"result\",\"subtype\":\"success\"}}\nexpect \"two\"\nemit {{\"type\":\"result\",\"subtype\":\"success\"}}\nidle"
    )]);
    let host = fx.open_with_thread(false);
    let (_, mut a) = host.subscribe_thread("t1", None).unwrap();
    let (_, mut b) = host.subscribe_thread("t1", None).unwrap();
    host.send("t1", text("one")).await.unwrap();
    assert_eq!(next(&mut a, "user_sent").await["content"], text("one"));
    assert_eq!(next(&mut b, "user_sent").await["content"], text("one"));
    drop(a);
    wait_until("idle", || host.thread_status("t1") == Some(ThreadStatus::Idle)).await;
    host.send("t1", text("two")).await.unwrap();
    assert_eq!(next(&mut b, "user_sent").await["content"], text("two"));
}

#[tokio::test(flavor = "multi_thread")]
async fn threads_come_back_from_disk_with_their_session_and_queue() {
    let fx = Fixture::new(&[&format!("{INIT}\nexpect \"one\"\nsleep 30")]);
    {
        let host = fx.open_with_thread(false);
        host.send("t1", text("one")).await.unwrap();
        host.send("t1", text("still queued")).await.unwrap();
        wait_until("session bound", || host.thread("t1").and_then(|t| t.session_id).is_some()).await;
        tokio::task::block_in_place(|| host.shutdown(Duration::from_secs(1)));
        host.flush();
    }
    let host = fx.open();
    let thread = host.thread("t1").expect("thread persisted");
    assert_eq!(thread.session_id.as_deref(), Some("sess-1"));
    assert_eq!(thread.queue.len(), 1);
    assert_eq!(thread.queue[0].content, text("still queued"));
    assert_eq!(host.thread_status("t1"), Some(ThreadStatus::NotStarted));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worktree_request_creates_the_worktree_before_the_first_start() {
    let fx = Fixture::new(&[&format!("{INIT}\nidle")]);
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").arg("-C").arg(&fx.project).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    let host = fx.open_with_thread(true);
    host.send("t1", text("hello")).await.unwrap();

    let thread = host.thread("t1").unwrap();
    let worktree = thread.worktree.expect("worktree recorded");
    assert!(!thread.worktree_requested);
    assert!(worktree.path.starts_with(&*fx.paths().worktrees_dir.to_string_lossy()), "{}", worktree.path);
    wait_until("launch", || !fx.read("cwd.1").is_empty()).await;
    let cwd = std::fs::canonicalize(fx.read("cwd.1").trim()).unwrap();
    assert_eq!(cwd, std::fs::canonicalize(&worktree.path).unwrap());
}

//! U8: the app's host connection against an in-process `speedy-agent`, over in-memory
//! streams, with speedy-core's fake `claude` (KTD9, KTD13, KTD14).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use speedy_agent::daemon;
use speedy_agent::paths::AgentPaths;
use speedy_agent::server::Agent;
use speedy_core::claude::ThreadStatus;
use speedy_core::env::{EnvPaths, EnvService};
use speedy_core::host::{Host, HostPaths, Launch, NewProject, NewThread};
use speedy_lib::hosts::connection::{ConnState, Connector, HostConn, Stream};
use speedy_lib::hosts::local::{Build, Upgrade, VersionInfo, decide};
use speedy_lib::hosts::status::StatusTracker;
use tokio::task::JoinHandle;

const WAIT: Duration = Duration::from_secs(15);

const INIT: &str = r#"expect "subtype":"initialize"
emit {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"commands":[],"pid":1}}}
emit {"type":"system","subtype":"init","session_id":"sess-1","slash_commands":[]}"#;

struct Fixture {
    _dir: tempfile::TempDir,
    agent: Arc<Agent>,
    /// Every serve task, so a test can cut the connection from the agent's side.
    serving: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl Fixture {
    fn new(scenario: &str) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["log", "project", "home"] {
            std::fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        std::fs::write(dir.path().join("scenario.1"), format!("{scenario}\n")).unwrap();
        let env_vars = HashMap::from([
            ("FAKE_CLAUDE_LOG".to_string(), dir.path().join("log").to_string_lossy().into_owned()),
            ("FAKE_CLAUDE_SCENARIO".to_string(), dir.path().join("scenario").to_string_lossy().into_owned()),
            ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
        ]);
        let program = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("crates/speedy-core/tests/fixtures/fake-claude");
        let launch = Arc::new(move || {
            let launch = Launch { program: program.clone(), env: env_vars.clone(), extension_settings: Map::new() };
            Box::pin(async move { Ok(launch) }) as std::pin::Pin<Box<dyn std::future::Future<Output = _> + Send>>
        });
        let host = Host::open(
            HostPaths {
                state_dir: dir.path().join("state"),
                chats_dir: dir.path().join("chats"),
                worktrees_dir: dir.path().join("worktrees"),
            },
            launch,
        );
        let project = dir.path().join("project").to_string_lossy().into_owned();
        host.add_project(NewProject { id: "p1".into(), path: project, name: "p".into() }).unwrap();
        host.create_thread("p1", NewThread { id: "t1".into(), ..Default::default() }).unwrap();
        let home = dir.path().join("home");
        let env = Arc::new(EnvService::start_with(EnvPaths {
            shell: "/bin/sh".into(),
            vscode_extensions_dir: home.join("ext"),
            vscode_settings_path: home.join("settings.json"),
            home,
            capture_timeout: Duration::from_secs(5),
        }));
        let paths = AgentPaths { root: dir.path().join("agent") };
        daemon::ensure_state_dir(&paths).unwrap();
        let agent = Agent::new(host, env, "host-1".into(), paths);
        Fixture { _dir: dir, agent, serving: Arc::default() }
    }

    fn connector(&self) -> Connector {
        let (agent, serving) = (self.agent.clone(), self.serving.clone());
        Arc::new(move || {
            let (ours, theirs) = tokio::io::duplex(1 << 20);
            serving.lock().push(tokio::spawn(agent.clone().serve(theirs)));
            Box::pin(async move { Ok(Box::new(ours) as Box<dyn Stream>) })
        })
    }

    /// Cuts every connection from the agent's side, as a dropped network would.
    fn cut(&self) {
        for task in self.serving.lock().drain(..) {
            task.abort();
        }
    }
}

/// Collects a sink's events.
#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Value>>>);

impl Seen {
    fn sink(&self) -> Arc<dyn Fn(Value) + Send + Sync> {
        let seen = self.0.clone();
        Arc::new(move |e| seen.lock().push(e))
    }

    async fn until(&self, what: &str, pred: impl Fn(&[Value]) -> bool) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while !pred(&self.0.lock()) {
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}: {:#?}", self.0.lock());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn kinds(&self) -> Vec<String> {
        self.0.lock().iter().map(|e| e["kind"].as_str().unwrap_or_default().to_owned()).collect()
    }
}

fn has_result(events: &[Value]) -> bool {
    events.iter().any(|e| e["kind"] == "message" && e["raw"]["type"] == "result")
}

async fn connected(conn: &HostConn) {
    let mut state = conn.watch();
    let wait = state.wait_for(|s| matches!(s, ConnState::Connected { .. }));
    tokio::time::timeout(WAIT, wait).await.expect("connects").unwrap();
}

fn text(s: &str) -> Value {
    json!([{"type": "text", "text": s}])
}

#[tokio::test(flavor = "multi_thread")]
async fn rpcs_and_thread_events_flow_through_the_connection() {
    let fx = Fixture::new(&format!("{INIT}\nexpect \"hi\"\nemit {{\"type\":\"result\",\"subtype\":\"success\"}}\nidle"));
    let conn = HostConn::start(fx.connector());
    connected(&conn).await;
    let (a, b) = (Seen::default(), Seen::default());
    conn.subscribe_thread("t1", a.sink());
    conn.subscribe_thread("t1", b.sink());
    tokio::time::sleep(Duration::from_millis(100)).await;
    conn.call("claude_send_user", json!({"threadId": "t1", "content": text("hi")})).await.unwrap();
    for seen in [&a, &b] {
        seen.until("the reply", has_result).await;
        assert!(seen.kinds().contains(&"user_sent".to_owned()));
    }
    let ConnState::Connected { host_id, .. } = conn.state() else { panic!("connected") };
    assert_eq!(host_id, "host-1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_connection_resumes_with_each_event_delivered_once_in_order() {
    let fx = Fixture::new(&format!(
        "{INIT}\nexpect \"hi\"\nsleep 1\nemit {{\"type\":\"assistant\",\"message\":{{}}}}\nemit {{\"type\":\"result\",\"subtype\":\"success\"}}\nidle"
    ));
    let conn = HostConn::start(fx.connector());
    connected(&conn).await;
    let seen = Seen::default();
    conn.subscribe_thread("t1", seen.sink());
    tokio::time::sleep(Duration::from_millis(100)).await;
    conn.call("claude_send_user", json!({"threadId": "t1", "content": text("hi")})).await.unwrap();
    seen.until("user_sent", |e| e.iter().any(|e| e["kind"] == "user_sent")).await;

    // The network drops mid-turn; the turn finishes while the client is away.
    fx.cut();
    seen.until("the reply after reconnecting", has_result).await;
    let events = seen.0.lock().clone();
    let snapshots = events.iter().filter(|e| e["kind"] == "snapshot").count();
    assert_eq!(snapshots, 1, "only the first subscribe, which had no cursor; the reconnect replays");
    let seqs: Vec<u64> = events.iter().filter_map(|e| e["seq"].as_u64()).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "each event once, in order: {seqs:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn catching_up_after_a_reconnect_reports_no_status_transitions() {
    let fx = Fixture::new(&format!("{INIT}\nexpect \"hi\"\nemit {{\"type\":\"result\",\"subtype\":\"success\"}}\nidle"));
    let transitions = Arc::new(Mutex::new(Vec::new()));
    let conn = HostConn::start(fx.connector());
    let tracker = Mutex::new(StatusTracker::default());
    let seen = transitions.clone();
    conn.subscribe_host(Arc::new(move |e| {
        if let Some(t) = tracker.lock().observe(&e) {
            seen.lock().push(t);
        }
    }));
    connected(&conn).await;
    conn.call("claude_send_user", json!({"threadId": "t1", "content": text("hi")})).await.unwrap();
    let finished = |t: &[(String, ThreadStatus, ThreadStatus)]| t.iter().any(|(_, f, to)| *f == ThreadStatus::Working && *to == ThreadStatus::Idle);
    let deadline = tokio::time::Instant::now() + WAIT;
    while !finished(&transitions.lock()) {
        assert!(tokio::time::Instant::now() < deadline, "no Working → Idle transition");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = transitions.lock().len();

    fx.cut();
    tokio::time::sleep(Duration::from_millis(500)).await;
    connected(&conn).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(transitions.lock().len(), before, "the reconnect's host snapshot is not a transition");
}

#[test]
fn status_tracker_only_reports_live_changes() {
    let mut t = StatusTracker::default();
    let snapshot = json!({"kind": "host_snapshot", "snapshot": {"statuses": {"a": "awaiting_user"}}});
    assert_eq!(t.observe(&snapshot), None);
    let status = |s: &str| json!({"kind": "thread_status", "id": "a", "status": s});
    assert_eq!(t.observe(&status("awaiting_user")), None, "unchanged");
    assert_eq!(t.observe(&status("working")), Some(("a".into(), ThreadStatus::AwaitingUser, ThreadStatus::Working)));
}

fn build(sha: &str, protocol: (u32, u32)) -> Build {
    Build {
        info: VersionInfo { version: "0.1.0".into(), protocol_min: protocol.0, protocol_max: protocol.1, build_sha: sha.into() },
        sha256: sha.repeat(8),
    }
}

#[test]
fn the_bundled_agent_replaces_the_installed_one_only_when_that_interrupts_nothing() {
    let bundled = build("bbbb", (1, 2));
    assert_eq!(decide(None, &bundled, false, false), Upgrade::Install, "first run");
    assert_eq!(decide(Some(&bundled), &bundled, true, true), Upgrade::UpToDate);
    assert_eq!(decide(Some(&bundled), &bundled, false, false), Upgrade::Install, "installed but stopped");
    let older = build("aaaa", (1, 1));
    assert_eq!(decide(Some(&older), &bundled, true, false), Upgrade::Install, "older and idle");
    assert_eq!(decide(Some(&older), &bundled, true, true), Upgrade::Pending, "older, compatible, busy");
    let ancient = build("0000", (0, 0));
    assert_eq!(decide(Some(&ancient), &bundled, true, true), Upgrade::Blocked, "incompatible and busy");
}

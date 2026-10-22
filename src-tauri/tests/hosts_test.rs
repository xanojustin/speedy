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
    // Subscribing returns once the agent has the subscriber, so the echo of a send can't beat it.
    conn.subscribe_thread("t1", a.sink()).await;
    conn.subscribe_thread("t1", b.sink()).await;
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
    conn.subscribe_thread("t1", seen.sink()).await;
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

fn build(version: &str, sha: &str, protocol: (u32, u32)) -> Build {
    Build {
        info: VersionInfo { version: version.into(), protocol_min: protocol.0, protocol_max: protocol.1, build_sha: sha.into(), build_time: 0 },
        sha256: sha.repeat(8),
    }
}

#[test]
fn the_bundled_agent_replaces_the_installed_one_only_when_that_interrupts_nothing() {
    let bundled = build("0.2.0", "bbbb", (1, 2));
    assert_eq!(decide(None, &bundled, false, false), Upgrade::Install, "first run");
    assert_eq!(decide(Some(&bundled), &bundled, true, true), Upgrade::UpToDate);
    assert_eq!(decide(Some(&bundled), &bundled, false, false), Upgrade::Install, "installed but stopped");
    let older = build("0.1.0", "aaaa", (1, 1));
    assert_eq!(decide(Some(&older), &bundled, true, false), Upgrade::Install, "older and idle");
    assert_eq!(decide(Some(&older), &bundled, false, false), Upgrade::Install, "older and stopped");
    assert_eq!(decide(Some(&older), &bundled, true, true), Upgrade::Pending, "older, compatible, busy");
    let ancient = build("0.0.1", "0000", (0, 0));
    assert_eq!(decide(Some(&ancient), &bundled, true, true), Upgrade::Blocked, "incompatible and busy");
    assert_eq!(decide(Some(&ancient), &bundled, true, false), Upgrade::Install, "incompatible and idle");
}

#[test]
fn a_newer_installed_agent_is_never_downgraded() {
    let bundled = build("0.2.0", "bbbb", (1, 2));
    let newer = build("0.3.0", "cccc", (2, 3));
    assert_eq!(decide(Some(&newer), &bundled, true, false), Upgrade::UpToDate, "newer, compatible, idle");
    assert_eq!(decide(Some(&newer), &bundled, false, false), Upgrade::Start, "newer and stopped: start it");
    // Two app builds on one host: each sees the other's agent; only the older app yields.
    let (a, b) = (build("0.2.0", "aaaa", (1, 1)), build("0.2.1", "bbbb", (1, 1)));
    assert_eq!(decide(Some(&a), &b, true, false), Upgrade::Install, "b upgrades a's older agent");
    assert_eq!(decide(Some(&b), &a, true, false), Upgrade::UpToDate, "a leaves b's newer agent be");
    // Same version: the later build wins, in either direction.
    let rebuilt = Build { info: VersionInfo { build_time: 200, ..bundled.info.clone() }, sha256: "ffff".repeat(8) };
    let built = Build { info: VersionInfo { build_time: 100, ..bundled.info.clone() }, ..bundled.clone() };
    assert_eq!(decide(Some(&built), &rebuilt, true, false), Upgrade::Install, "a rebuild replaces the idle agent");
    assert_eq!(decide(Some(&rebuilt), &built, true, false), Upgrade::UpToDate, "an earlier build leaves it be");
    // Same version and build time: no ordering, so a running one is kept by both.
    let twin = build("0.2.0", "dddd", (1, 2));
    assert_eq!(decide(Some(&twin), &bundled, true, false), Upgrade::UpToDate);
    assert_eq!(decide(Some(&bundled), &twin, true, false), Upgrade::UpToDate);
    // A newer agent that can't talk to this app at all is replaced once idle.
    let breaking = build("1.0.0", "eeee", (3, 3));
    assert_eq!(decide(Some(&breaking), &bundled, true, false), Upgrade::Install);
    assert_eq!(decide(Some(&breaking), &bundled, true, true), Upgrade::Blocked);
}

#[test]
fn agent_versions_order_numerically_with_prereleases_first() {
    use speedy_lib::hosts::local::version_cmp;
    use std::cmp::Ordering::*;
    assert_eq!(version_cmp("0.10.0", "0.9.9"), Some(Greater));
    assert_eq!(version_cmp("1.0.0-beta", "1.0.0"), Some(Less));
    assert_eq!(version_cmp("1.0", "1.0.0"), Some(Equal));
    assert_eq!(version_cmp("1.0.0+abc", "1.0.0+def"), Some(Equal));
    assert_eq!(version_cmp("dev", "1.0.0"), None);
}

#[tokio::test(start_paused = true)]
async fn an_agent_that_goes_silent_is_dropped_even_while_pings_go_out() {
    use speedy_core::proto::{Body, Control, Frame, Hello, MAGIC, WIRE_VERSION, encode};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Says Hello, then reads (and ignores) everything without ever answering.
    let connector: Connector = Arc::new(|| {
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        tokio::spawn(async move {
            let hello = Hello {
                protocol_min: 1,
                protocol_max: 1,
                agent_version: "test".into(),
                build_sha: "test".into(),
                host_id: Some("mute".into()),
                epoch: Some(1),
                capabilities: vec![],
            };
            let mut bytes = MAGIC.to_vec();
            bytes.extend_from_slice(&WIRE_VERSION.to_le_bytes());
            bytes.extend(encode(&Frame { stream_id: 0, body: Body::Control(Control::Hello(hello)) }).unwrap());
            theirs.write_all(&bytes).await.unwrap();
            let mut sink = [0u8; 1024];
            while theirs.read(&mut sink).await.is_ok_and(|n| n > 0) {}
        });
        Box::pin(async move { Ok(Box::new(ours) as Box<dyn Stream>) })
    });
    let conn = HostConn::start(connector);
    connected(&conn).await;
    let mut state = conn.watch();
    let dropped = state.wait_for(|s| matches!(s, ConnState::Reconnecting { error } if error.contains("stopped answering")));
    tokio::time::timeout(Duration::from_secs(60), dropped).await.expect("dropped within a minute of silence").unwrap();
}

/// The agent's side of a handshake: preamble and Hello.
fn agent_hello_bytes() -> Vec<u8> {
    use speedy_core::proto::{Body, Control, Frame, Hello, MAGIC, WIRE_VERSION, encode};
    let hello = Hello {
        protocol_min: 1,
        protocol_max: 1,
        agent_version: "test".into(),
        build_sha: "test".into(),
        host_id: Some("fake".into()),
        epoch: Some(1),
        capabilities: vec![],
    };
    let mut bytes = MAGIC.to_vec();
    bytes.extend_from_slice(&WIRE_VERSION.to_le_bytes());
    bytes.extend(encode(&Frame { stream_id: 0, body: Body::Control(Control::Hello(hello)) }).unwrap());
    bytes
}

#[tokio::test(start_paused = true)]
async fn an_agent_that_never_sends_its_preamble_is_reconnected_to() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    // Accepts the connection, then says nothing (kept open so the read never ends).
    let held = Arc::new(Mutex::new(Vec::new()));
    let (count, keep) = (calls.clone(), held.clone());
    let connector: Connector = Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        let (ours, theirs) = tokio::io::duplex(1 << 16);
        keep.lock().push(theirs);
        Box::pin(async move { Ok(Box::new(ours) as Box<dyn Stream>) })
    });
    let conn = HostConn::start(connector);
    let mut state = conn.watch();
    let timed_out = state.wait_for(|s| matches!(s, ConnState::Reconnecting { error } if error.contains("preamble")));
    tokio::time::timeout(Duration::from_secs(60), timed_out).await.expect("the handshake times out").unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while calls.load(Ordering::SeqCst) < 2 {
        assert!(tokio::time::Instant::now() < deadline, "no reconnect attempt");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(start_paused = true)]
async fn reconnect_now_abandons_a_stuck_connect() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    // The first connect never finishes (an SSH master that hangs); later ones fail at once.
    let connector: Connector = Arc::new(move || {
        let first = count.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first {
                std::future::pending::<()>().await;
            }
            Err("unreachable".to_owned())
        })
    });
    let conn = HostConn::start(connector);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    conn.reconnect_now();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(calls.load(Ordering::SeqCst) >= 2, "the stuck connect was abandoned for a fresh one");
}

#[tokio::test(start_paused = true)]
async fn a_removed_host_stops_reconnecting() {
    use speedy_lib::hosts::HostRegistry;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let registry = HostRegistry::new_in(dir.path().to_path_buf());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let connector: Connector = Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Err("unreachable".to_owned()) })
    });
    let conn = registry.add("gone", connector, Arc::new(|_, _, _| {}));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while calls.load(Ordering::SeqCst) < 2 {
        assert!(tokio::time::Instant::now() < deadline, "no reconnect attempts");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    registry.remove("gone").await;
    assert!(conn.is_closed());
    tokio::time::sleep(Duration::from_millis(10)).await;
    let after = calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(calls.load(Ordering::SeqCst), after, "the connector isn't called after remove");
    assert!(registry.get("gone").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn frames_around_the_subscribe_reply_reach_the_sink_in_order() {
    use speedy_core::proto::{Body, Event, Frame, FrameReader, Response, encode};
    use tokio::io::AsyncWriteExt;
    const LAST: u64 = 300;
    // Sends a replay's first events before the subscribe reply and the rest right after it,
    // in one write, so the reader routes live frames while the reply is still being handled.
    let connector: Connector = Arc::new(|| {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        tokio::spawn(async move {
            let (rd, mut wr) = tokio::io::split(theirs);
            wr.write_all(&agent_hello_bytes()).await.unwrap();
            let mut reader = FrameReader::new(rd);
            let event = |seq: u64| {
                encode(&Frame { stream_id: 7, body: Body::Event(Event { epoch: 1, seq, event: json!({"kind": "e", "seq": seq}) }) }).unwrap()
            };
            while let Ok(Some(frame)) = reader.read_frame().await {
                let Body::Request(req) = frame.body else { continue };
                if req.method != "thread_subscribe" {
                    continue;
                }
                let mut bytes = Vec::new();
                (1..=3).for_each(|seq| bytes.extend(event(seq)));
                let reply = Response { id: req.id, result: Ok(json!({"streamId": 7, "snapshot": null})) };
                bytes.extend(encode(&Frame { stream_id: 0, body: Body::Response(reply) }).unwrap());
                (4..=LAST).for_each(|seq| bytes.extend(event(seq)));
                wr.write_all(&bytes).await.unwrap();
            }
        });
        Box::pin(async move { Ok(Box::new(ours) as Box<dyn Stream>) })
    });
    for _ in 0..20 {
        let conn = HostConn::start(connector.clone());
        connected(&conn).await;
        let seen = Seen::default();
        conn.subscribe_thread("t1", seen.sink()).await;
        seen.until("every event", |e| e.len() as u64 >= LAST).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let seqs: Vec<u64> = seen.0.lock().iter().filter_map(|e| e["seq"].as_u64()).collect();
        assert_eq!(seqs, (1..=LAST).collect::<Vec<_>>(), "gap-free and in order");
        conn.close();
    }
}

//! U6: the agent serving several clients over in-memory streams, against the fake `claude`
//! in speedy-core's fixtures and a real `/bin/sh` for terminals (KTD5, KTD7, KTD8, KTD12).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use speedy_agent::clients::{Outbox, StreamError};
use speedy_agent::daemon::{self, EXIT_NOT_RUNNING};
use speedy_agent::paths::AgentPaths;
use speedy_agent::pty_ring::{Catchup, PtyRing};
use speedy_agent::server::{Agent, peer_allowed};
use speedy_core::env::{EnvPaths, EnvService};
use speedy_core::host::{Host, HostPaths, Launch, LaunchFn, NewProject, NewThread};
use speedy_core::proto::{
    Body, Control, Frame, FrameReader, Hello, MAGIC, MAX_FRAME_LEN, PROTOCOL_MAX, PROTOCOL_MIN, Request, WIRE_VERSION, encode,
};
use tokio::io::{AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};

const WAIT: Duration = Duration::from_secs(15);

const INIT: &str = r#"expect "subtype":"initialize"
emit {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"commands":[],"pid":1}}}
emit {"type":"system","subtype":"init","session_id":"sess-1","slash_commands":[]}"#;

struct Fixture {
    dir: tempfile::TempDir,
    project: PathBuf,
}

impl Fixture {
    fn new(scenario: &str) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["log", "project", "home"] {
            std::fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        std::fs::write(dir.path().join("scenario.1"), format!("{scenario}\n")).unwrap();
        let project = dir.path().join("project");
        Fixture { dir, project }
    }

    fn launch(&self) -> LaunchFn {
        let env = HashMap::from([
            ("FAKE_CLAUDE_LOG".to_string(), self.dir.path().join("log").to_string_lossy().into_owned()),
            ("FAKE_CLAUDE_SCENARIO".to_string(), self.dir.path().join("scenario").to_string_lossy().into_owned()),
            ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
        ]);
        let program = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../speedy-core/tests/fixtures/fake-claude");
        Arc::new(move || {
            let launch = Launch { program: program.clone(), env: env.clone(), extension_settings: Map::new() };
            Box::pin(async move { Ok(launch) })
        })
    }

    fn agent(&self) -> Arc<Agent> {
        let paths = HostPaths {
            state_dir: self.dir.path().join("state"),
            chats_dir: self.dir.path().join("chats"),
            worktrees_dir: self.dir.path().join("worktrees"),
        };
        let host = Host::open(paths, self.launch());
        host.add_project(NewProject { id: "p1".into(), path: self.project.to_string_lossy().into_owned(), name: "p".into() })
            .unwrap();
        host.create_thread("p1", NewThread { id: "t1".into(), ..Default::default() }).unwrap();
        let home = self.dir.path().join("home");
        let env = Arc::new(EnvService::start_with(EnvPaths {
            shell: "/bin/sh".into(),
            vscode_extensions_dir: home.join("ext"),
            vscode_settings_path: home.join("settings.json"),
            home,
            capture_timeout: Duration::from_secs(5),
        }));
        let agent_paths = AgentPaths { root: self.dir.path().join("agent") };
        daemon::ensure_state_dir(&agent_paths).unwrap();
        Agent::new(host, env, "host-1".into(), agent_paths)
    }

    fn stdin(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("log/stdin.1"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

/// A protocol client over one end of an in-memory stream.
struct Client {
    reader: FrameReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    next_id: u64,
    /// Frames read while waiting for something else.
    pending: VecDeque<Frame>,
    hello: Hello,
}

impl Client {
    /// `buffer` bounds the in-memory pipe, so a client that stops reading backs up the agent.
    async fn connect(agent: &Arc<Agent>, buffer: usize) -> Client {
        let (ours, theirs) = tokio::io::duplex(buffer);
        tokio::spawn(agent.clone().serve(theirs));
        let (rd, mut writer) = tokio::io::split(ours);
        let mut reader = FrameReader::new(rd);
        reader.read_preamble().await.unwrap();
        let Some(Frame { body: Body::Control(Control::Hello(hello)), .. }) = reader.read_frame().await.unwrap() else {
            panic!("agent opens with Hello")
        };
        let ours = Hello {
            protocol_min: PROTOCOL_MIN,
            protocol_max: PROTOCOL_MAX,
            agent_version: "test".into(),
            build_sha: "test".into(),
            host_id: None,
            epoch: None,
            capabilities: vec![],
        };
        let bytes = encode(&Frame { stream_id: 0, body: Body::Control(Control::Hello(ours)) }).unwrap();
        writer.write_all(&bytes).await.unwrap();
        Client { reader, writer, next_id: 1, pending: VecDeque::new(), hello }
    }

    async fn read(&mut self) -> Frame {
        if let Some(frame) = self.pending.pop_front() {
            return frame;
        }
        tokio::time::timeout(WAIT, self.reader.read_frame()).await.expect("frame within WAIT").unwrap().expect("open")
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let bytes = encode(&Frame { stream_id: 0, body: Body::Request(Request { id, method: method.into(), params }) }).unwrap();
        self.writer.write_all(&bytes).await.unwrap();
        let mut skipped = VecDeque::new();
        loop {
            let frame = tokio::time::timeout(WAIT, self.reader.read_frame()).await.expect("response").unwrap().expect("open");
            match frame.body {
                Body::Response(r) if r.id == id => {
                    self.pending.extend(skipped);
                    return r.result;
                }
                _ => skipped.push_back(frame),
            }
        }
    }

    /// The next event on `stream_id` whose kind is `kind`, skipping others.
    async fn event(&mut self, stream_id: u32, kind: &str) -> Value {
        loop {
            let frame = self.read().await;
            if let Body::Event(e) = frame.body
                && frame.stream_id == stream_id
                && e.event["kind"] == kind
            {
                return e.event;
            }
        }
    }

    async fn subscribe(&mut self, cursor: Value) -> (u32, Value) {
        let r = self.call("thread_subscribe", json!({"threadId": "t1", "cursor": cursor})).await.unwrap();
        (r["streamId"].as_u64().unwrap() as u32, r)
    }
}

fn text(s: &str) -> Value {
    json!([{"type": "text", "text": s}])
}

fn turn(msg: &str) -> String {
    format!("expect \"{msg}\"\nemit {{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"re {msg}\"}}]}}}}\nemit {{\"type\":\"result\",\"subtype\":\"success\"}}")
}

#[tokio::test(flavor = "multi_thread")]
async fn two_clients_drive_one_thread_and_both_see_everything() {
    let fx = Fixture::new(&format!("{INIT}\n{}\nidle", turn("hi")));
    let agent = fx.agent();
    let mut a = Client::connect(&agent, 1 << 20).await;
    let mut b = Client::connect(&agent, 1 << 20).await;
    assert_eq!(a.hello.host_id.as_deref(), Some("host-1"));
    let (sa, _) = a.subscribe(Value::Null).await;
    let (sb, _) = b.subscribe(Value::Null).await;
    a.call("claude_send_user", json!({"threadId": "t1", "content": text("hi")})).await.unwrap();
    for (client, stream) in [(&mut a, sa), (&mut b, sb)] {
        assert_eq!(client.event(stream, "user_sent").await["content"], text("hi"));
        loop {
            let e = client.event(stream, "message").await;
            if e["raw"]["type"] == "result" {
                break;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_disconnects_mid_turn_catches_up_from_its_cursor() {
    let fx = Fixture::new(&format!("{INIT}\nexpect \"hi\"\nsleep 0.5\nemit {{\"type\":\"result\",\"subtype\":\"success\"}}\nidle"));
    let agent = fx.agent();
    let mut a = Client::connect(&agent, 1 << 20).await;
    let (stream, sub) = a.subscribe(Value::Null).await;
    let epoch = sub["epoch"].as_u64().unwrap();
    a.call("claude_send_user", json!({"threadId": "t1", "content": text("hi")})).await.unwrap();
    let sent = a.event(stream, "user_sent").await;
    let seen = sent["seq"].as_u64().unwrap();
    drop(a);

    // The turn finishes with nobody connected; a new client resumes after `seen`.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let mut b = Client::connect(&agent, 1 << 20).await;
    let (stream, sub) = b.subscribe(json!({"epoch": epoch, "seq": seen})).await;
    assert!(sub["snapshot"].is_null(), "same epoch, retained cursor: replay, not snapshot");
    let result = loop {
        let e = b.event(stream, "message").await;
        if e["raw"]["type"] == "result" {
            break e;
        }
    };
    assert!(result["seq"].as_u64().unwrap() > seen);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_stops_reading_is_cut_off_while_the_others_keep_flowing() {
    let fx = Fixture::new(&format!("{INIT}\nidle"));
    let agent = fx.agent();
    // `slow` never reads after attaching; its 64 KB pipe fills and its queue backs up past
    // the 8 MiB budget well before the 24 MB flood ends.
    let mut slow = Client::connect(&agent, 64 << 10).await;
    let mut fast = Client::connect(&agent, 1 << 20).await;
    let cwd = fx.project.to_string_lossy().into_owned();
    let open = json!({"terminalId": "t1", "cwd": cwd, "cols": 80, "rows": 24});
    let slow_stream = slow.call("pty_open", open.clone()).await.unwrap()["streamId"].as_u64().unwrap() as u32;
    let fast_stream = fast.call("pty_open", open.clone()).await.unwrap()["streamId"].as_u64().unwrap() as u32;
    // Markers are computed, so the shell's echo of the typed line never matches them.
    let flood = "head -c 24000000 /dev/zero | tr '\\0' x; echo; echo FLOOD-$((6*7))-DONE\n";
    fast.call("pty_write", json!({"terminalId": "t1", "data": flood})).await.unwrap();

    // A reader that falls behind the burst is cut off too; like the app, it reattaches
    // from the last offset it has.
    // Only a window is kept: the marker can share a chunk with a long prompt after it.
    let mut window = Vec::new();
    let mut end = 0u64;
    let mut fast_stream = fast_stream;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !String::from_utf8_lossy(&window).contains("FLOOD-42-DONE") {
        assert!(tokio::time::Instant::now() < deadline, "the fast client never saw the flood finish");
        let frame = fast.read().await;
        match frame.body {
            Body::PtyData { offset, data } if frame.stream_id == fast_stream => {
                end = offset + data.len() as u64;
                let keep_from = window.len().saturating_sub(64);
                window.drain(..keep_from);
                window.extend(data);
            }
            Body::Control(Control::Lagged { .. }) => {
                let reopen = json!({"terminalId": "t1", "cwd": cwd, "cols": 80, "rows": 24, "offset": end});
                fast_stream = fast.call("pty_open", reopen).await.unwrap()["streamId"].as_u64().unwrap() as u32;
            }
            _ => {}
        }
    }
    // Now drain the slow client: somewhere in its backlog it was told it lagged.
    let lagged = loop {
        match slow.read().await.body {
            Body::Control(Control::Lagged { stream_id, .. }) => break stream_id,
            _ => continue,
        }
    };
    assert_eq!(lagged, slow_stream);
}

#[tokio::test(flavor = "multi_thread")]
async fn reattaching_to_a_terminal_sends_exactly_what_was_missed() {
    let fx = Fixture::new(&format!("{INIT}\nidle"));
    let agent = fx.agent();
    let mut a = Client::connect(&agent, 1 << 20).await;
    let cwd = fx.project.to_string_lossy().into_owned();
    a.call("pty_open", json!({"terminalId": "t1", "cwd": cwd, "cols": 80, "rows": 24})).await.unwrap();
    a.call("pty_write", json!({"terminalId": "t1", "data": "echo FIRST-$((1+1))\n"})).await.unwrap();
    let mut seen = 0u64;
    let mut out = Vec::new();
    while !String::from_utf8_lossy(&out).contains("FIRST-2") {
        if let Body::PtyData { offset, data } = a.read().await.body {
            seen = offset + data.len() as u64;
            out.extend(data);
        }
    }
    drop(a);

    let mut b = Client::connect(&agent, 1 << 20).await;
    b.call("pty_write", json!({"terminalId": "t1", "data": "echo SECOND-$((2+1))\n"})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let r = b.call("pty_open", json!({"terminalId": "t1", "cwd": cwd, "cols": 80, "rows": 24, "offset": seen})).await.unwrap();
    let stream = r["streamId"].as_u64().unwrap() as u32;
    let frame = b.read().await;
    assert_eq!(frame.stream_id, stream);
    let Body::PtyData { offset, data } = frame.body else { panic!("catch-up bytes first, no reset: {:?}", frame.body) };
    assert_eq!(offset, seen);
    let missed = String::from_utf8_lossy(&data);
    assert!(missed.contains("SECOND-3") && !missed.contains("FIRST-2"), "{missed:?}");
}

#[test]
fn the_ring_resets_a_client_further_behind_than_it_reaches() {
    let mut ring = PtyRing::new(10);
    ring.push(b"0123456789");
    ring.push(b"abcde");
    assert_eq!(ring.after(Some(12)), Catchup::Bytes { offset: 12, data: b"cde".to_vec() });
    assert_eq!(ring.after(Some(2)), Catchup::Reset { offset: 5, data: b"56789abcde".to_vec() });
    assert_eq!(ring.after(None), Catchup::Reset { offset: 5, data: b"56789abcde".to_vec() });
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_run_exits_cleanly_and_proxy_reports_no_agent() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AgentPaths { root: dir.path().join("agent") };
    assert_eq!(daemon::proxy(paths.clone()).await, EXIT_NOT_RUNNING, "nothing ever ran");

    daemon::ensure_state_dir(&paths).unwrap();
    let held = daemon::try_lock(&paths).unwrap().expect("free");
    assert!(daemon::agent_running(&paths));
    // Another `run` while the lock is held returns at once, without touching the socket.
    tokio::time::timeout(Duration::from_secs(5), daemon::run(paths.clone())).await.unwrap().unwrap();
    assert!(!paths.socket().exists());
    drop(held);
    assert!(!daemon::agent_running(&paths));
    assert_eq!(daemon::proxy(paths).await, EXIT_NOT_RUNNING);
}

#[test]
fn only_the_agents_own_user_may_connect() {
    let me = unsafe { libc::geteuid() };
    assert!(peer_allowed(me));
    assert!(!peer_allowed(me + 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn shutting_down_denies_pending_prompts_and_stops_the_thread() {
    let fx = Fixture::new(&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"perm-1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{}}}}}}
ignore_term
idle"#
    ));
    let agent = fx.agent();
    let mut a = Client::connect(&agent, 1 << 20).await;
    let (stream, _) = a.subscribe(Value::Null).await;
    a.call("claude_send_user", json!({"threadId": "t1", "content": text("go")})).await.unwrap();
    a.event(stream, "permission_request").await;
    assert_eq!(a.call("agent_busy", json!({})).await.unwrap(), true, "a prompt is waiting");
    let stopping = agent.clone();
    let started = std::time::Instant::now();
    tokio::task::spawn_blocking(move || stopping.shut_down()).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(8));
    let stdin = fx.stdin();
    assert!(stdin.iter().any(|v| v["response"]["request_id"] == "perm-1" && v["response"]["response"]["behavior"] == "deny"));
    assert!(stdin.iter().any(|v| v["request"]["subtype"] == "interrupt"));
}

#[tokio::test(flavor = "multi_thread")]
async fn setup_reports_how_the_agent_runs_and_never_echoes_the_token() {
    let fx = Fixture::new(&format!("{INIT}\nidle"));
    let agent = fx.agent();
    let mut a = Client::connect(&agent, 1 << 20).await;
    assert_eq!(a.call("agent_busy", json!({})).await.unwrap(), false, "nothing is running");
    let setup = a.call("get_setup_state", json!({})).await.unwrap();
    assert!(setup["launchDomain"].is_string(), "{setup}");
    assert_eq!(setup["tokenPresent"], false);

    let after = a.call("set_claude_token", json!({"token": "sk-ant-oat-secret-123"})).await.unwrap();
    assert_eq!(after["tokenPresent"], true);
    let host = a.call("host_subscribe", json!({})).await.unwrap();
    for reply in [after, host] {
        assert!(!reply.to_string().contains("secret-123"), "token leaked: {reply}");
    }
}

#[tokio::test]
async fn a_reply_too_large_for_a_frame_becomes_an_error_reply() {
    let (outbox, mut rx) = Outbox::new(1 << 20);
    outbox.reply(7, Ok(Value::String("x".repeat(MAX_FRAME_LEN + 1))));
    let out = rx.try_recv().expect("something is sent, so the caller doesn't hang");
    let frame = FrameReader::new(&out.bytes[..]).read_frame().await.unwrap().unwrap();
    let Body::Response(r) = frame.body else { panic!("a response: {:?}", frame.body) };
    assert_eq!(r.id, 7);
    let err = r.result.unwrap_err();
    assert!(err.starts_with("reply too large ("), "{err}");

    // An oversized stream frame is reported as unsendable, not as the client lagging, so
    // the stream skips it instead of sending the client into a resubscribe loop.
    let huge = Frame { stream_id: 3, body: Body::PtyData { offset: 0, data: vec![0; MAX_FRAME_LEN] } };
    assert!(matches!(outbox.try_stream(&huge), Err(StreamError::Unencodable(_))));
    assert!(rx.try_recv().is_err(), "no Lagged for it");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shutdown_sent_while_nobody_waits_is_not_lost() {
    let fx = Fixture::new(&format!("{INIT}\nidle"));
    let agent = fx.agent();
    let mut a = Client::connect(&agent, 1 << 20).await;
    let bytes = encode(&Frame { stream_id: 0, body: Body::Control(Control::Shutdown) }).unwrap();
    a.writer.write_all(&bytes).await.unwrap();
    // A round trip, so the agent has handled the Shutdown before anyone waits for it.
    a.call("agent_busy", json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), agent.shutdown_requested()).await.expect("the request was kept");
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_fails_when_the_agent_never_exits() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AgentPaths { root: dir.path().join("agent") };
    daemon::ensure_state_dir(&paths).unwrap();
    // A wedged agent: holds the lock and takes the Shutdown, but never exits.
    let _held = daemon::try_lock(&paths).unwrap().expect("free");
    let listener = tokio::net::UnixListener::bind(paths.socket()).unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        stream.write_all(MAGIC).await.unwrap();
        stream.write_all(&WIRE_VERSION.to_le_bytes()).await.unwrap();
        let mut sink = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut sink).await;
    });
    let err = daemon::stop_within(paths.clone(), Duration::from_millis(300)).await.unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::TimedOut, "{err}");
    assert!(daemon::agent_running(&paths));
}

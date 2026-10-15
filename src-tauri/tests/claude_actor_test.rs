//! U3: Claude session actor against `tests/fixtures/fake-claude` (a scripted
//! stand-in for the CLI), plus one opt-in contract test against the real CLI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use speedy_lib::claude::actor::{self, ActorConfig, ClaudeActor};
use speedy_lib::claude::{ClaudeEvent, StartOptions, ThreadStatus};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

const WAIT: Duration = Duration::from_secs(10);

/// Answers our `initialize` control_request.
const INIT: &str = r#"expect "subtype":"initialize"
emit {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"commands":[],"pid":1}}}"#;

const BASE_FLAGS: [&str; 8] = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
];

fn fake_claude() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-claude")
}

struct Events {
    rx: UnboundedReceiver<ClaudeEvent>,
    seen: Vec<ClaudeEvent>,
}

impl Events {
    async fn wait_for(&mut self, what: &str, mut pred: impl FnMut(&ClaudeEvent) -> bool) -> ClaudeEvent {
        self.wait_for_within(what, WAIT, &mut pred).await
    }

    async fn wait_for_within(
        &mut self,
        what: &str,
        within: Duration,
        pred: &mut impl FnMut(&ClaudeEvent) -> bool,
    ) -> ClaudeEvent {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(e)) => {
                    self.seen.push(e.clone());
                    if pred(&e) {
                        return e;
                    }
                }
                Ok(None) => panic!("event stream closed waiting for {what}; seen: {:#?}", summarize(&self.seen)),
                Err(_) => panic!("timed out waiting for {what}; seen: {:#?}", summarize(&self.seen)),
            }
        }
    }

    async fn wait_status(&mut self, status: ThreadStatus) -> ClaudeEvent {
        self.wait_for(&format!("status {status:?}"), |e| matches!(e, ClaudeEvent::Status { status: s, .. } if *s == status))
            .await
    }

    /// Drains whatever has arrived within `quiet`.
    async fn settle(&mut self, quiet: Duration) {
        while let Ok(Some(e)) = tokio::time::timeout(quiet, self.rx.recv()).await {
            self.seen.push(e);
        }
    }

    fn statuses(&self) -> Vec<ThreadStatus> {
        self.seen
            .iter()
            .filter_map(|e| match e {
                ClaudeEvent::Status { status, .. } => Some(*status),
                _ => None,
            })
            .collect()
    }

    fn messages(&self) -> Vec<&Value> {
        self.seen
            .iter()
            .filter_map(|e| match e {
                ClaudeEvent::Message { raw, .. } => Some(raw),
                _ => None,
            })
            .collect()
    }
}

fn seq_of(e: &ClaudeEvent) -> u64 {
    match e {
        ClaudeEvent::Message { seq, .. }
        | ClaudeEvent::Initialized { seq, .. }
        | ClaudeEvent::SessionBound { seq, .. }
        | ClaudeEvent::Status { seq, .. }
        | ClaudeEvent::PermissionRequest { seq, .. }
        | ClaudeEvent::PermissionResolved { seq, .. }
        | ClaudeEvent::Stderr { seq, .. }
        | ClaudeEvent::ProtocolError { seq, .. } => *seq,
    }
}

fn summarize(events: &[ClaudeEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| {
            let s = format!("{e:?}");
            if s.len() > 200 { format!("{}…", &s[..200]) } else { s }
        })
        .collect()
}

fn assert_seq_increasing(events: &[ClaudeEvent]) {
    let seqs: Vec<u64> = events.iter().map(seq_of).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seq not strictly increasing: {seqs:?}");
}

struct Fake {
    _dir: tempfile::TempDir,
    log: PathBuf,
    cwd: PathBuf,
    scenario: PathBuf,
}

impl Fake {
    /// `scenarios[i]` drives launch i+1.
    fn new(scenarios: &[&str]) -> Fake {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&log).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let scenario = dir.path().join("scenario");
        for (i, s) in scenarios.iter().enumerate() {
            std::fs::write(format!("{}.{}", scenario.display(), i + 1), format!("{s}\n")).unwrap();
        }
        Fake { _dir: dir, log, cwd, scenario }
    }

    fn options(&self) -> StartOptions {
        StartOptions { cwd: self.cwd.to_string_lossy().into_owned(), ..Default::default() }
    }

    fn config(&self, options: StartOptions, settings: Map<String, Value>) -> ActorConfig {
        let mut env = HashMap::new();
        env.insert("FAKE_CLAUDE_LOG".to_string(), self.log.to_string_lossy().into_owned());
        env.insert("FAKE_CLAUDE_SCENARIO".to_string(), self.scenario.to_string_lossy().into_owned());
        ActorConfig { program: fake_claude(), options, env, extension_settings: settings }
    }

    fn start(&self) -> (ClaudeActor, Events) {
        self.start_with(self.options(), Map::new())
    }

    fn start_with(&self, options: StartOptions, settings: Map<String, Value>) -> (ClaudeActor, Events) {
        let (tx, rx) = unbounded_channel();
        let actor = ClaudeActor::start(
            self.config(options, settings),
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
            Arc::new(|_, _| {}),
        );
        (actor, Events { rx, seen: vec![] })
    }

    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.log.join(name)).unwrap_or_default()
    }

    fn lines(&self, name: &str) -> Vec<String> {
        self.read(name).lines().map(str::to_owned).collect()
    }

    fn launches(&self) -> u32 {
        self.read("launches").trim().parse().unwrap_or(0)
    }

    /// Parsed lines the fake read from its stdin on launch `n`.
    fn stdin(&self, n: u32) -> Vec<Value> {
        self.lines(&format!("stdin.{n}"))
            .iter()
            .map(|l| serde_json::from_str(l).expect("actor writes JSON lines"))
            .collect()
    }

    async fn wait_file(&self, name: &str, within: Duration) {
        let deadline = Instant::now() + within;
        while !self.log.join(name).exists() {
            assert!(Instant::now() < deadline, "{name} never appeared");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn pid_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn wait_dead(pid: i32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while pid_alive(pid) {
        if Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

fn text(s: &str) -> Value {
    json!([{"type": "text", "text": s}])
}

#[tokio::test(flavor = "multi_thread")]
async fn launch_uses_exactly_the_ktd4_flags_and_checkpointing_env() {
    let fake = Fake::new(&[&format!("{INIT}\nidle")]);
    let (_actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    assert_eq!(fake.lines("argv.1"), BASE_FLAGS);
    let env = fake.lines("env.1");
    assert!(env.contains(&"CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true".to_string()));
    assert!(env.contains(&format!("FAKE_CLAUDE_LOG={}", fake.log.display())), "resolved env reaches the child");
    assert_eq!(fake.read("cwd.1").trim(), fake.cwd.canonicalize().unwrap().to_string_lossy());

    // Optional flags only when set, plus the extension-settings parity items.
    let fake = Fake::new(&[&format!("{INIT}\nidle")]);
    let options = StartOptions {
        resume_session_id: Some("sess-9".into()),
        model: Some("haiku".into()),
        permission_mode: Some("plan".into()),
        max_thinking_tokens: Some(1024),
        ..fake.options()
    };
    let mut settings = Map::new();
    settings.insert("claudeCode.allowDangerouslySkipPermissions".into(), json!(true));
    settings.insert(
        "claudeCode.environmentVariables".into(),
        json!([{"name": "FROM_SETTINGS", "value": "yes"}]),
    );
    let (_actor, mut ev) = fake.start_with(options, settings);
    ev.wait_status(ThreadStatus::Idle).await;
    let mut expected: Vec<&str> = BASE_FLAGS.to_vec();
    expected.extend([
        "--resume",
        "sess-9",
        "--model",
        "haiku",
        "--permission-mode",
        "plan",
        "--max-thinking-tokens",
        "1024",
        "--allow-dangerously-skip-permissions",
    ]);
    assert_eq!(fake.lines("argv.1"), expected);
    let env = fake.lines("env.1");
    assert!(env.contains(&"FROM_SETTINGS=yes".to_string()));
    assert!(env.contains(&"CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true".to_string()));
}

/// Replays the transcript recorded against CLI 2.1.296 (U1): initialize, a
/// denied Bash `can_use_tool`, a result, then a second turn that is interrupted.
#[tokio::test(flavor = "multi_thread")]
async fn recorded_transcript_replays_in_order_through_permission_and_interrupt() {
    let fixture = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cli-2.1.296-permission-deny-interrupt.ndjson"),
    )
    .unwrap();
    let mut scenario = String::new();
    let mut expected_messages: Vec<Value> = vec![];
    let mut permission_id = String::new();
    for line in fixture.lines() {
        let rec: Value = serde_json::from_str(line).unwrap();
        let msg = &rec["msg"];
        if rec["dir"] == "out" {
            let pattern = match (msg["type"].as_str(), msg["request"]["subtype"].as_str()) {
                (Some("control_request"), Some(sub)) => format!(r#""subtype":"{sub}""#),
                (Some("control_response"), _) => {
                    format!(r#""request_id":"{}""#, msg["response"]["request_id"].as_str().unwrap())
                }
                _ => r#""type":"user""#.to_string(),
            };
            scenario.push_str(&format!("expect {pattern}\n"));
        } else {
            match msg["type"].as_str() {
                Some("control_request") => {
                    permission_id = msg["request_id"].as_str().unwrap().to_string();
                }
                Some("control_response") => {}
                _ => expected_messages.push(msg.clone()),
            }
            let raw = serde_json::to_string(msg)
                .unwrap()
                .replace(r#""request_id":"init-1""#, r#""request_id":"@ID@""#)
                .replace(r#""request_id":"int-1""#, r#""request_id":"@ID@""#);
            scenario.push_str(&format!("emit {raw}\n"));
        }
    }
    scenario.push_str("idle\n");

    let fake = Fake::new(&[&scenario]);
    let (actor, mut ev) = fake.start();
    ev.wait_for("initialized", |e| matches!(e, ClaudeEvent::Initialized { .. })).await;
    ev.wait_status(ThreadStatus::Idle).await;

    actor.send_user(text("Use the Bash tool")).await.unwrap();
    let req = ev.wait_for("permission request", |e| matches!(e, ClaudeEvent::PermissionRequest { .. })).await;
    let ClaudeEvent::PermissionRequest { request_id, request, diff, .. } = req else { unreachable!() };
    assert_eq!(request_id, permission_id);
    assert_eq!(request["tool_name"], "Bash");
    assert!(diff.is_none(), "Bash has no diff");

    let deny = json!({"behavior": "deny", "message": "Denied by test"});
    let outcome = actor.respond_permission(&request_id, deny.clone()).await.unwrap();
    assert!(outcome.sent);
    ev.wait_status(ThreadStatus::Idle).await;

    actor.send_user(text("Write the numbers 1 to 300")).await.unwrap();
    ev.wait_for("second turn streaming", |e| {
        matches!(e, ClaudeEvent::Message { raw, .. } if raw["type"] == "system" && raw["subtype"] == "thinking_tokens")
    })
    .await;
    actor.interrupt().await.unwrap();
    ev.wait_status(ThreadStatus::Idle).await;
    ev.settle(Duration::from_millis(200)).await;

    use ThreadStatus::*;
    assert_eq!(ev.statuses(), vec![Starting, Idle, Working, AwaitingUser, Working, Idle, Working, Idle]);
    let got: Vec<Value> = ev.messages().into_iter().cloned().collect();
    assert_eq!(got.len(), expected_messages.len());
    assert!(got == expected_messages, "non-control lines pass through verbatim and in order");
    let bound: Vec<&ClaudeEvent> = ev.seen.iter().filter(|e| matches!(e, ClaudeEvent::SessionBound { .. })).collect();
    assert_eq!(bound.len(), 1, "SessionBound once per distinct id");
    assert!(
        matches!(bound[0], ClaudeEvent::SessionBound { session_id, .. } if session_id == "04f13abf-e3ec-4946-98c7-67cc5cced041")
    );
    assert_seq_increasing(&ev.seen);

    let stdin = fake.stdin(1);
    let answer = stdin.iter().find(|v| v["type"] == "control_response").expect("decision written");
    assert_eq!(
        answer,
        &json!({"type": "control_response", "response": {"subtype": "success", "request_id": permission_id, "response": deny}})
    );
    let user = stdin.iter().find(|v| v["type"] == "user").unwrap();
    assert_eq!(
        user,
        &json!({"type": "user", "message": {"role": "user", "content": text("Use the Bash tool")}, "parent_tool_use_id": null, "session_id": ""})
    );
    assert!(stdin.iter().any(|v| v["type"] == "control_request" && v["request"]["subtype"] == "interrupt"));
}

#[tokio::test(flavor = "multi_thread")]
async fn can_use_tool_awaits_the_user_and_the_decision_carries_the_request_id() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"perm-1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"ls"}},"tool_use_id":"t1"}}}}
expect "request_id":"perm-1"
emit {{"type":"result","subtype":"success","is_error":false}}
idle"#
    )]);
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("go")).await.unwrap();
    ev.wait_status(ThreadStatus::AwaitingUser).await;
    assert_eq!(actor.status(), ThreadStatus::AwaitingUser);
    let allow = json!({"behavior": "allow", "updatedInput": {"command": "ls"}});
    assert!(actor.respond_permission("perm-1", allow.clone()).await.unwrap().sent);
    ev.wait_status(ThreadStatus::Working).await;
    ev.wait_status(ThreadStatus::Idle).await;
    let stdin = fake.stdin(1);
    assert!(stdin.contains(&json!({"type":"control_response","response":{"subtype":"success","request_id":"perm-1","response":allow}})));
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_types_and_extra_fields_pass_through_unchanged() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
emit {{"type":"brand_new_kind","nested":{{"a":[1,2,{{"b":null}}]}},"z":"✓"}}
emit {{"type":"assistant","message":{{"content":[]}},"future_field":{{"x":1}}}}
idle"#
    )]);
    let (_actor, mut ev) = fake.start();
    ev.wait_for("assistant", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["type"] == "assistant")).await;
    assert_eq!(
        ev.messages(),
        vec![
            &json!({"type":"brand_new_kind","nested":{"a":[1,2,{"b":null}]},"z":"✓"}),
            &json!({"type":"assistant","message":{"content":[]},"future_field":{"x":1}}),
        ]
    );
    assert!(!ev.seen.iter().any(|e| matches!(e, ClaudeEvent::ProtocolError { .. })));
}

#[tokio::test(flavor = "multi_thread")]
async fn partial_lines_are_buffered_and_unparseable_lines_become_protocol_errors() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
partial {{"type":"spl
sleep 0.3
emit it","n":1}}
emit this is not json
emit {{"type":"after"}}
idle"#
    )]);
    let (actor, mut ev) = fake.start();
    ev.wait_for("after", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["type"] == "after")).await;
    assert_eq!(ev.messages(), vec![&json!({"type":"split","n":1}), &json!({"type":"after"})]);
    let errors: Vec<&String> = ev
        .seen
        .iter()
        .filter_map(|e| match e {
            ClaudeEvent::ProtocolError { line, .. } => Some(line),
            _ => None,
        })
        .collect();
    assert_eq!(errors, vec!["this is not json"]);
    assert_eq!(actor.status(), ThreadStatus::Idle);
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_mid_turn_reports_stderr_then_respawns_once_with_resume() {
    let fake = Fake::new(&[
        &format!(
            r#"{INIT}
emit {{"type":"system","subtype":"init","session_id":"sess-1"}}
expect "type":"user"
stderr fatal: something broke
exit 3"#
        ),
        &format!("{INIT}\nidle"),
    ]);
    let (actor, mut ev) = fake.start();
    ev.wait_for("session bound", |e| matches!(e, ClaudeEvent::SessionBound { session_id, .. } if session_id == "sess-1"))
        .await;
    // Idle (initialize response) and SessionBound (next line) may arrive in either order.
    if !ev.statuses().contains(&ThreadStatus::Idle) {
        ev.wait_status(ThreadStatus::Idle).await;
    }
    actor.send_user(text("hi")).await.unwrap();
    let crashed = ev.wait_status(ThreadStatus::Crashed).await;
    let ClaudeEvent::Status { detail, stderr_tail, .. } = crashed else { unreachable!() };
    assert!(stderr_tail.unwrap().contains("fatal: something broke"));
    assert!(detail.unwrap().contains('3'));
    let starting = ev.wait_status(ThreadStatus::Starting).await;
    assert!(matches!(starting, ClaudeEvent::Status { reconnecting: true, .. }));
    ev.wait_status(ThreadStatus::Idle).await;

    assert!(!fake.lines("argv.1").contains(&"--resume".to_string()));
    let argv2 = fake.lines("argv.2");
    assert_eq!(&argv2[argv2.len() - 2..], ["--resume", "sess-1"]);
    assert_eq!(fake.launches(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn second_crash_soon_after_respawn_stays_crashed_until_retry() {
    let fake = Fake::new(&[
        &format!("{INIT}\nemit {{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-2\"}}\nsleep 0.2\nexit 3"),
        &format!("{INIT}\nexit 4"),
        &format!("{INIT}\nidle"),
    ]);
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Crashed).await;
    ev.wait_status(ThreadStatus::Starting).await;
    ev.wait_status(ThreadStatus::Crashed).await;
    ev.settle(Duration::from_millis(700)).await;
    assert_eq!(fake.launches(), 2, "no second automatic respawn");
    assert_eq!(actor.status(), ThreadStatus::Crashed);
    assert_eq!(ev.statuses().last(), Some(&ThreadStatus::Crashed));

    assert_eq!(actor.retry(), ThreadStatus::Starting);
    ev.wait_status(ThreadStatus::Idle).await;
    assert_eq!(fake.launches(), 3);
    let argv3 = fake.lines("argv.3");
    assert_eq!(&argv3[argv3.len() - 2..], ["--resume", "sess-2"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_actors_never_cross_deliver_events() {
    let a = Fake::new(&[&format!("{INIT}\nburst 300 A\nidle")]);
    let b = Fake::new(&[&format!("{INIT}\nburst 300 B\nidle")]);
    let (_aa, mut ea) = a.start();
    let (_ab, mut eb) = b.start();
    let (ra, rb) = tokio::join!(
        ea.wait_for("A done", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["i"] == 299)),
        eb.wait_for("B done", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["i"] == 299)),
    );
    for (ev, who, last) in [(&ea, "A", ra), (&eb, "B", rb)] {
        let ticks: Vec<&Value> = ev.messages().into_iter().filter(|m| m["type"] == "tick").collect();
        assert_eq!(ticks.len(), 300);
        assert!(ticks.iter().all(|m| m["who"] == who), "{who} received another thread's events");
        assert!(ticks.iter().enumerate().all(|(i, m)| m["i"] == i), "{who} out of order");
        assert_eq!(seq_of(&last), seq_of(ev.seen.last().unwrap()));
        assert_seq_increasing(&ev.seen);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn control_requests_resolve_with_payload_error_or_timeout() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
expect "subtype":"set_model"
emit {{"type":"control_response","response":{{"subtype":"success","request_id":"@ID@","response":{{"model":"haiku"}}}}}}
expect "subtype":"rename_session"
emit {{"type":"control_response","response":{{"subtype":"error","request_id":"@ID@","error":"no session"}}}}
idle"#
    )]);
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    let ok = actor.control(json!({"subtype": "set_model", "model": "haiku"}), None).await;
    assert_eq!(ok, Ok(json!({"model": "haiku"})));
    let err = actor.control(json!({"subtype": "rename_session", "title": "x"}), None).await;
    assert_eq!(err, Err("no session".to_string()));

    let started = Instant::now();
    let timed_out = actor.control(json!({"subtype": "get_context_usage"}), Some(Duration::from_millis(300))).await;
    assert!(timed_out.unwrap_err().contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(actor.status(), ThreadStatus::Idle);

    let sent = fake.stdin(1);
    let set_model = sent.iter().find(|v| v["request"]["subtype"] == "set_model").unwrap();
    assert_eq!(set_model["type"], "control_request");
    assert!(set_model["request_id"].as_str().is_some_and(|id| !id.is_empty()));
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupt_with_pending_permission_denies_first_then_interrupts_and_reaches_idle() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"req-7","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"sleep 5"}}}}}}
expect "request_id":"req-7"
expect "subtype":"interrupt"
emit {{"type":"control_response","response":{{"subtype":"success","request_id":"@ID@","response":{{"still_queued":[]}}}}}}
emit {{"type":"result","subtype":"error_during_execution","is_error":true}}
idle"#
    )]);
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("go")).await.unwrap();
    ev.wait_status(ThreadStatus::AwaitingUser).await;
    tokio::time::timeout(WAIT, actor.interrupt()).await.expect("interrupt does not hang").unwrap();
    ev.wait_status(ThreadStatus::Idle).await;
    assert!(ev.seen.iter().any(|e| matches!(e,
        ClaudeEvent::PermissionResolved { request_id, reason, .. } if request_id == "req-7" && reason == "interrupted")));

    let sent = fake.stdin(1);
    let deny = sent.iter().position(|v| v["type"] == "control_response").expect("deny sent");
    let interrupt = sent.iter().position(|v| v["request"]["subtype"] == "interrupt").expect("interrupt sent");
    assert!(deny < interrupt, "deny goes out before the interrupt");
    assert_eq!(
        sent[deny]["response"],
        json!({"subtype":"success","request_id":"req-7","response":{"behavior":"deny","message":"Interrupted by user"}})
    );
    assert!(actor.respond_permission("req-7", json!({"behavior":"allow","updatedInput":{}})).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn slow_consumer_never_blocks_a_20mb_burst() {
    let fake = Fake::new(&[&format!("{INIT}\nflood 160 F\nidle")]);
    let (_actor, mut ev) = fake.start();
    // Nobody reads events until the child has written all ~20 MB.
    fake.wait_file("flood.done", Duration::from_secs(30)).await;
    ev.wait_for("last flood line", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["i"] == 159)).await;
    let floods = ev.messages().into_iter().filter(|m| m["type"] == "flood").count();
    assert_eq!(floods, 160);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_terminates_the_whole_process_group() {
    let fake = Fake::new(&[&format!("{INIT}\nspawn_sleep\nidle"), &format!("{INIT}\nidle")]);
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    fake.wait_file("sleep.pid", WAIT).await;
    let sleep_pid: i32 = fake.read("sleep.pid").trim().parse().unwrap();
    let cli_pid: i32 = fake.read("pid.1").trim().parse().unwrap();
    assert!(pid_alive(sleep_pid));

    actor.stop(Duration::from_secs(2)).await;
    ev.wait_status(ThreadStatus::Stopped).await;
    assert!(wait_dead(cli_pid, Duration::from_secs(3)).await, "CLI still running");
    assert!(wait_dead(sleep_pid, Duration::from_secs(3)).await, "child in the CLI's group survived");
    ev.settle(Duration::from_millis(300)).await;
    assert_eq!(fake.launches(), 1, "a stop is not a crash");
    assert_eq!(actor.status(), ThreadStatus::Stopped);

    // Reopening the thread relaunches the same actor; seq keeps increasing.
    assert_eq!(actor.restart(fake.options()), ThreadStatus::Starting);
    ev.wait_status(ThreadStatus::Idle).await;
    assert_eq!(fake.launches(), 2);
    assert_seq_increasing(&ev.seen);
}

#[tokio::test(flavor = "multi_thread")]
async fn allow_on_a_stale_diff_refreshes_instead_of_sending() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"req-e","request":{{"subtype":"can_use_tool","tool_name":"Edit","input":{{"file_path":"a.txt","old_string":"hello","new_string":"bye"}}}}}}
expect "request_id":"req-e"
emit {{"type":"result","subtype":"success","is_error":false}}
idle"#
    )]);
    std::fs::write(fake.cwd.join("a.txt"), "hello\n").unwrap();
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("edit it")).await.unwrap();
    let req = ev.wait_for("permission", |e| matches!(e, ClaudeEvent::PermissionRequest { .. })).await;
    let ClaudeEvent::PermissionRequest { diff: Some(shown), .. } = req else { panic!("Edit request carries a diff") };
    assert!(shown[0].unified.contains("-hello") && shown[0].unified.contains("+bye"));

    // Another thread writes the file after the diff was shown.
    std::fs::write(fake.cwd.join("a.txt"), "hello world\n").unwrap();
    let allow = json!({"behavior":"allow","updatedInput":{"file_path":"a.txt","old_string":"hello","new_string":"bye"}});
    let outcome = actor.respond_permission("req-e", allow.clone()).await.unwrap();
    assert!(!outcome.sent);
    let refreshed = outcome.refreshed_diff.expect("refreshed diff");
    assert_ne!(refreshed[0].base_fingerprint, shown[0].base_fingerprint);
    assert!(refreshed[0].unified.contains("-hello world") && refreshed[0].unified.contains("+bye world"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(fake.stdin(1).iter().all(|v| v["type"] != "control_response"), "nothing written for a stale diff");
    assert_eq!(actor.status(), ThreadStatus::AwaitingUser);

    // Accepting the refreshed diff sends the allow.
    assert!(actor.respond_permission("req-e", allow).await.unwrap().sent);
    ev.wait_status(ThreadStatus::Idle).await;
    assert!(fake.stdin(1).iter().any(|v| v["response"]["request_id"] == "req-e"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cli_cancel_drops_the_pending_request_and_other_control_requests_get_an_error() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"hook-1","request":{{"subtype":"hook_callback","callback_id":"x"}}}}
expect "request_id":"hook-1"
emit {{"type":"control_request","request_id":"req-c","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{}}}}}}
emit {{"type":"control_cancel_request","request_id":"req-c"}}
idle"#
    )]);
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("go")).await.unwrap();
    ev.wait_for("cancelled", |e| matches!(e,
        ClaudeEvent::PermissionResolved { request_id, reason, .. } if request_id == "req-c" && reason == "cancelled"))
        .await;
    ev.wait_status(ThreadStatus::Working).await;
    let hook_answer = fake.stdin(1).into_iter().find(|v| v["response"]["request_id"] == "hook-1").unwrap();
    assert_eq!(hook_answer["response"]["subtype"], "error");
    assert!(ev.messages().iter().all(|m| m["type"] != "control_request" && m["type"] != "control_cancel_request"));
}

#[tokio::test(flavor = "multi_thread")]
async fn rebinding_moves_events_to_the_new_sink_and_keeps_seq() {
    let fake = Fake::new(&[&format!("{INIT}\nexpect \"type\":\"user\"\nemit {{\"type\":\"after_rebind\"}}\nidle")]);
    let (actor, mut first) = fake.start();
    first.wait_status(ThreadStatus::Idle).await;
    let last_seq = seq_of(first.seen.last().unwrap());
    let (tx, rx) = unbounded_channel();
    actor.rebind(Arc::new(move |e| {
        let _ = tx.send(e);
    }));
    let mut second = Events { rx, seen: vec![] };
    actor.send_user(text("hi")).await.unwrap();
    let e = second.wait_for("after", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["type"] == "after_rebind")).await;
    assert!(seq_of(&e) > last_seq);
    first.settle(Duration::from_millis(100)).await;
    assert!(first.messages().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_all_denies_pending_interrupts_and_kills_groups() {
    let fake = Fake::new(&[&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"req-q","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{}}}}}}
spawn_sleep
ignore_term
idle"#
    )]);
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("go")).await.unwrap();
    ev.wait_status(ThreadStatus::AwaitingUser).await;
    fake.wait_file("sleep.pid", WAIT).await;
    let sleep_pid: i32 = fake.read("sleep.pid").trim().parse().unwrap();
    let cli_pid: i32 = fake.read("pid.1").trim().parse().unwrap();

    let started = Instant::now();
    let actors = vec![actor.clone()];
    tokio::task::spawn_blocking(move || actor::shutdown_all(&actors, Duration::from_secs(1))).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(4));
    // The fake ignores SIGTERM, so only the SIGKILL after the grace period stops it.
    assert!(wait_dead(cli_pid, Duration::from_secs(3)).await);
    assert!(wait_dead(sleep_pid, Duration::from_secs(3)).await);

    let sent = fake.stdin(1);
    let deny = sent.iter().position(|v| v["response"]["request_id"] == "req-q").expect("pending request denied");
    assert_eq!(sent[deny]["response"]["response"]["behavior"], "deny");
    let interrupt = sent.iter().position(|v| v["request"]["subtype"] == "interrupt").expect("interrupt sent");
    assert!(deny < interrupt);
    ev.settle(Duration::from_millis(300)).await;
    assert_eq!(fake.launches(), 1, "quitting is not a crash");
    assert_eq!(actor.status(), ThreadStatus::Stopped);
}

/// Opt-in drift check against the installed CLI: `cargo test -- --ignored`.
/// Runs in a temp dir, uses haiku, and denies every tool request.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "talks to the real claude CLI; run manually after CLI upgrades"]
async fn contract_real_cli_initialize_prompt_interrupt() {
    let program = std::env::var("CLAUDE_BIN").map(PathBuf::from).unwrap_or_else(|_| {
        let out = std::process::Command::new("sh").args(["-c", "command -v claude"]).output().unwrap();
        PathBuf::from(String::from_utf8(out.stdout).unwrap().trim())
    });
    assert!(program.is_file(), "claude CLI not found; set CLAUDE_BIN");
    let dir = tempfile::tempdir().unwrap();
    let options = StartOptions {
        cwd: dir.path().to_string_lossy().into_owned(),
        model: Some("haiku".into()),
        permission_mode: Some("default".into()),
        ..Default::default()
    };
    let (tx, rx) = unbounded_channel();
    let actor = ClaudeActor::start(
        ActorConfig { program, options, env: HashMap::new(), extension_settings: Map::new() },
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
        Arc::new(|_, _| {}),
    );
    let mut ev = Events { rx, seen: vec![] };

    // Every tool request is denied, never allowed.
    async fn until(ev: &mut Events, actor: &ClaudeActor, what: &str, mut done: impl FnMut(&ClaudeEvent) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let e = ev.wait_for_within(what, left, &mut |_| true).await;
            if let ClaudeEvent::PermissionRequest { request_id, .. } = &e {
                let deny = json!({"behavior": "deny", "message": "Denied by Speedy contract test"});
                actor.respond_permission(request_id, deny).await.unwrap();
            }
            if done(&e) {
                return;
            }
        }
    }

    until(&mut ev, &actor, "initialized", |e| matches!(e, ClaudeEvent::Initialized { .. })).await;
    until(&mut ev, &actor, "idle", |e| matches!(e, ClaudeEvent::Status { status: ThreadStatus::Idle, .. })).await;
    actor.send_user(text("Reply with the single word ok. Do not use any tools.")).await.unwrap();
    until(&mut ev, &actor, "stream", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["type"] == "stream_event")).await;
    until(&mut ev, &actor, "result", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["type"] == "result")).await;
    until(&mut ev, &actor, "idle after result", |e| matches!(e, ClaudeEvent::Status { status: ThreadStatus::Idle, .. })).await;
    assert!(ev.seen.iter().any(|e| matches!(e, ClaudeEvent::SessionBound { .. })));
    assert_eq!(actor.status(), ThreadStatus::Idle);

    actor.send_user(text("Write the numbers 1 to 300 as words, one per line. No tools.")).await.unwrap();
    until(&mut ev, &actor, "second stream", |e| matches!(e, ClaudeEvent::Message { raw, .. } if raw["type"] == "stream_event")).await;
    actor.interrupt().await.unwrap();
    until(&mut ev, &actor, "idle after interrupt", |e| matches!(e, ClaudeEvent::Status { status: ThreadStatus::Idle, .. })).await;
    actor.stop(Duration::from_secs(3)).await;
}

/// U11 rewind: a fork resumes the original session truncated at a message. The
/// truncation and fork flags apply only while resuming the original; once the
/// fork's own session is bound, a respawn resumes the fork as-is.
#[tokio::test(flavor = "multi_thread")]
async fn fork_at_message_applies_only_until_the_fork_is_bound() {
    let fake = Fake::new(&[
        &format!(
            r#"{INIT}
expect "type":"user"
emit {{"type":"system","subtype":"init","session_id":"fork-1"}}
stderr fatal: something broke
exit 3"#
        ),
        &format!("{INIT}\nidle"),
    ]);
    let options = StartOptions {
        resume_session_id: Some("orig".into()),
        resume_session_at: Some("anchor-uuid".into()),
        fork_session: Some(true),
        ..fake.options()
    };
    let (actor, mut ev) = fake.start_with(options, Map::new());
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("hi")).await.unwrap();
    ev.wait_for("fork bound", |e| matches!(e, ClaudeEvent::SessionBound { session_id, .. } if session_id == "fork-1"))
        .await;
    ev.wait_status(ThreadStatus::Crashed).await;
    ev.wait_status(ThreadStatus::Starting).await;
    ev.wait_status(ThreadStatus::Idle).await;

    let argv1 = fake.lines("argv.1");
    assert_eq!(
        &argv1[BASE_FLAGS.len()..],
        ["--resume", "orig", "--resume-session-at", "anchor-uuid", "--fork-session"]
    );
    let argv2 = fake.lines("argv.2");
    assert_eq!(&argv2[BASE_FLAGS.len()..], ["--resume", "fork-1"]);
}

fn flag_value(argv: &[String], name: &str) -> Option<String> {
    argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1).cloned())
}

/// Review #2: a respawn after a crash keeps the mode/model the user switched to
/// mid-session; a failed switch is not applied.
#[tokio::test(flavor = "multi_thread")]
async fn crash_respawn_keeps_live_permission_mode_and_model_changes() {
    let fake = Fake::new(&[
        &format!(
            r#"{INIT}
expect "subtype":"set_permission_mode"
emit {{"type":"control_response","response":{{"subtype":"success","request_id":"@ID@","response":{{}}}}}}
expect "subtype":"set_model"
emit {{"type":"control_response","response":{{"subtype":"success","request_id":"@ID@","response":{{}}}}}}
expect "subtype":"set_permission_mode"
emit {{"type":"control_response","response":{{"subtype":"error","request_id":"@ID@","error":"nope"}}}}
exit 3"#
        ),
        &format!("{INIT}\nidle"),
    ]);
    let options =
        StartOptions { model: Some("opus".into()), permission_mode: Some("acceptEdits".into()), ..fake.options() };
    let (actor, mut ev) = fake.start_with(options, Map::new());
    ev.wait_status(ThreadStatus::Idle).await;
    let mode = actor.control(json!({"subtype": "set_permission_mode", "mode": "default"}), None).await;
    assert!(mode.is_ok(), "{mode:?}");
    let model = actor.control(json!({"subtype": "set_model", "model": "haiku"}), None).await;
    assert!(model.is_ok(), "{model:?}");
    let refused = actor.control(json!({"subtype": "set_permission_mode", "mode": "bypassPermissions"}), None).await;
    assert!(refused.is_err());
    ev.wait_status(ThreadStatus::Crashed).await;
    ev.wait_status(ThreadStatus::Idle).await;

    let argv1 = fake.lines("argv.1");
    assert_eq!(flag_value(&argv1, "--permission-mode").as_deref(), Some("acceptEdits"));
    let argv2 = fake.lines("argv.2");
    assert_eq!(flag_value(&argv2, "--permission-mode").as_deref(), Some("default"), "{argv2:?}");
    assert_eq!(flag_value(&argv2, "--model").as_deref(), Some("haiku"), "{argv2:?}");
}

/// Review #2: an allow whose `updatedPermissions` switches mode is kept across a respawn.
#[tokio::test(flavor = "multi_thread")]
async fn crash_respawn_keeps_a_mode_set_by_a_permission_allow() {
    let fake = Fake::new(&[
        &format!(
            r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"perm-m","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"ls"}}}}}}
expect "request_id":"perm-m"
exit 3"#
        ),
        &format!("{INIT}\nidle"),
    ]);
    let options = StartOptions { permission_mode: Some("default".into()), ..fake.options() };
    let (actor, mut ev) = fake.start_with(options, Map::new());
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("go")).await.unwrap();
    ev.wait_status(ThreadStatus::AwaitingUser).await;
    let allow = json!({
        "behavior": "allow",
        "updatedInput": {"command": "ls"},
        "updatedPermissions": [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]
    });
    assert!(actor.respond_permission("perm-m", allow).await.unwrap().sent);
    ev.wait_status(ThreadStatus::Crashed).await;
    ev.wait_status(ThreadStatus::Idle).await;
    let argv2 = fake.lines("argv.2");
    assert_eq!(flag_value(&argv2, "--permission-mode").as_deref(), Some("acceptEdits"), "{argv2:?}");
}

/// Review #7: once a stale diff could not be re-diffed, every further allow stays
/// blocked (not just the first) and nothing reaches the CLI.
#[tokio::test(flavor = "multi_thread")]
async fn allow_keeps_blocking_while_a_stale_diff_cannot_be_rediffed() {
    // replace_all of "a" with 1000 bytes: fine on "b\n", a >64 MiB blow-up once
    // the file holds 70k "a"s, so the re-diff yields nothing.
    let new_string = "x".repeat(1000);
    let fake = Fake::new(&[&format!(
        r#"{INIT}
expect "type":"user"
emit {{"type":"control_request","request_id":"req-s","request":{{"subtype":"can_use_tool","tool_name":"Edit","input":{{"file_path":"a.txt","old_string":"a","new_string":"{new_string}","replace_all":true}}}}}}
idle"#
    )]);
    std::fs::write(fake.cwd.join("a.txt"), "b\n").unwrap();
    let (actor, mut ev) = fake.start();
    ev.wait_status(ThreadStatus::Idle).await;
    actor.send_user(text("edit it")).await.unwrap();
    let req = ev.wait_for("permission", |e| matches!(e, ClaudeEvent::PermissionRequest { .. })).await;
    let ClaudeEvent::PermissionRequest { diff: Some(shown), .. } = req else { panic!("Edit request carries a diff") };
    assert_eq!(shown.len(), 1);

    std::fs::write(fake.cwd.join("a.txt"), "a".repeat(70_000)).unwrap();
    let allow = json!({"behavior": "allow", "updatedInput": {"file_path": "a.txt", "old_string": "a", "new_string": new_string, "replace_all": true}});
    for attempt in 1..=3 {
        let outcome = actor.respond_permission("req-s", allow.clone()).await.unwrap();
        assert!(!outcome.sent, "allow #{attempt} must stay blocked");
        assert_eq!(outcome.refreshed_diff, Some(vec![]), "allow #{attempt}");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(fake.stdin(1).iter().all(|v| v["type"] != "control_response"), "nothing written while blocked");
    assert_eq!(actor.status(), ThreadStatus::AwaitingUser);

    // A deny still goes through.
    assert!(actor.respond_permission("req-s", json!({"behavior": "deny", "message": "no"})).await.unwrap().sent);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        fake.stdin(1)
            .iter()
            .any(|v| v["response"]["request_id"] == "req-s" && v["response"]["response"]["behavior"] == "deny")
    );
}

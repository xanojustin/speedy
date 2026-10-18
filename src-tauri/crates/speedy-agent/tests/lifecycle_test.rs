//! U7: how the agent runs on macOS (KTD8): its LaunchAgent, the token fallback for hosts
//! where `claude` can't reach the login Keychain, and holding the host awake while working.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;
use speedy_agent::launchd::{LABEL, plist};
use speedy_agent::paths::AgentPaths;
use speedy_agent::power::{PowerBackend, hold_awake_while_working};
use speedy_agent::token::{claude_env, set_token, token_present};
use tokio::sync::mpsc::unbounded_channel;

#[test]
fn the_launch_agent_restarts_on_crash_only_and_runs_unthrottled() {
    let paths = AgentPaths { root: PathBuf::from("/Users/me/.speedy/agent") };
    let xml = plist(&paths, None);
    assert!(xml.contains(&format!("<key>Label</key>\n\t<string>{LABEL}</string>")), "{xml}");
    assert!(xml.contains("<string>/Users/me/.speedy/agent/bin/current/speedy-agent</string>\n\t\t<string>run</string>"), "{xml}");
    // A second agent that loses the lock exits 0, which KeepAlive must not respawn.
    assert!(xml.contains("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>"), "{xml}");
    assert!(xml.contains("<key>ProcessType</key>\n\t<string>Interactive</string>"), "{xml}");
    assert!(xml.contains("<key>RunAtLoad</key>\n\t<true/>"), "{xml}");
    assert!(!xml.contains("SPEEDY_AGENT_HOME"), "the default home needs no override");

    let custom = plist(&paths, Some(&paths.root));
    assert!(custom.contains("<key>SPEEDY_AGENT_HOME</key>\n\t\t<string>/Users/me/.speedy/agent</string>"), "{custom}");
}

#[test]
fn the_token_reaches_only_the_claude_child() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AgentPaths { root: dir.path().to_path_buf() };
    std::fs::create_dir_all(paths.state_dir()).unwrap();
    let shared = HashMap::from([("PATH".to_string(), "/usr/bin".to_string())]);

    assert!(!token_present(&paths));
    assert!(!claude_env(&paths, shared.clone()).contains_key("CLAUDE_CODE_OAUTH_TOKEN"));

    set_token(&paths, "sk-ant-oat-secret").unwrap();
    assert!(token_present(&paths));
    let mode = std::fs::metadata(paths.state_dir().join("claude-token")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let env = claude_env(&paths, shared.clone());
    assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "sk-ant-oat-secret");
    assert_eq!(env["PATH"], "/usr/bin");
    // The shared env that shells and git use is a separate map and never gets it.
    assert!(!shared.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));

    // Replacing the token keeps the file private.
    set_token(&paths, "sk-ant-oat-newer").unwrap();
    assert_eq!(claude_env(&paths, shared)["CLAUDE_CODE_OAUTH_TOKEN"], "sk-ant-oat-newer");
}

#[derive(Default)]
struct FakePower {
    calls: Mutex<Vec<&'static str>>,
}

struct Fake(Arc<FakePower>);

impl PowerBackend for Fake {
    fn hold(&mut self) {
        self.0.calls.lock().push("hold");
    }
    fn release(&mut self) {
        self.0.calls.lock().push("release");
    }
}

async fn settle(power: &FakePower, n: usize) -> Vec<&'static str> {
    for _ in 0..200 {
        if power.calls.lock().len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    power.calls.lock().clone()
}

#[tokio::test]
async fn the_host_stays_awake_only_while_a_thread_works() {
    let power = Arc::new(FakePower::default());
    let (tx, rx) = unbounded_channel();
    tokio::spawn(hold_awake_while_working(Default::default(), rx, Fake(power.clone())));
    let status = |id: &str, s: &str| Arc::new(json!({"kind": "thread_status", "id": id, "status": s}));

    tx.send(status("a", "working")).unwrap();
    tx.send(status("b", "working")).unwrap();
    tx.send(status("a", "idle")).unwrap();
    assert_eq!(settle(&power, 1).await, ["hold"], "still held while b works");
    tx.send(status("b", "awaiting_user")).unwrap();
    assert_eq!(settle(&power, 2).await, ["hold", "release"], "a prompt waiting for the user lets the host sleep");
    tx.send(Arc::new(json!({"kind": "thread_removed", "id": "b"}))).unwrap();
    tx.send(status("c", "working")).unwrap();
    assert_eq!(settle(&power, 3).await, ["hold", "release", "hold"]);
}

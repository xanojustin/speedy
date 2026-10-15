//! U3: spawn contract for the `claude` CLI (KTD4) and process-group signalling (KTD9).

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tokio::process::{Child, Command};

use super::StartOptions;

/// Always passed, matching the extension's SDK with the stdio permission prompt.
pub const BASE_FLAGS: [&str; 8] = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
];

const SKIP_PERMISSIONS_SETTING: &str = "claudeCode.allowDangerouslySkipPermissions";
const ENV_VARS_SETTING: &str = "claudeCode.environmentVariables";

/// KTD4 arguments; optional flags only when set. `resume` is the session to resume, if any.
pub fn build_args(options: &StartOptions, resume: Option<&str>, settings: &Map<String, Value>) -> Vec<String> {
    let mut args: Vec<String> = BASE_FLAGS.iter().map(|s| s.to_string()).collect();
    let mut flag = |name: &str, value: Option<String>| {
        if let Some(v) = value {
            args.push(name.into());
            args.push(v);
        }
    };
    flag("--resume", resume.map(str::to_owned));
    // Rewind fork: only while resuming the original session. Once the fork's own
    // session is bound, a respawn resumes it as-is instead of re-truncating it.
    let resuming_original = resume.is_some() && resume == options.resume_session_id.as_deref();
    if resuming_original {
        flag("--resume-session-at", options.resume_session_at.clone());
    }
    flag("--model", options.model.clone());
    flag("--permission-mode", options.permission_mode.clone());
    flag("--max-thinking-tokens", options.max_thinking_tokens.map(|n| n.to_string()));
    if resuming_original && options.fork_session == Some(true) {
        args.push("--fork-session".into());
    }
    // Parity with the extension: without this flag the CLI rejects bypass mode.
    if settings.get(SKIP_PERMISSIONS_SETTING).and_then(Value::as_bool) == Some(true) {
        args.push("--allow-dangerously-skip-permissions".into());
    }
    args
}

/// Child env overlay: resolved login env, then `claudeCode.environmentVariables`,
/// then the checkpointing flag rewind depends on.
pub fn build_env(resolved: &HashMap<String, String>, settings: &Map<String, Value>) -> HashMap<String, String> {
    let mut env = resolved.clone();
    for entry in settings.get(ENV_VARS_SETTING).and_then(Value::as_array).into_iter().flatten() {
        if let (Some(name), Some(value)) = (entry["name"].as_str(), entry["value"].as_str()) {
            env.insert(name.to_owned(), value.to_owned());
        }
    }
    env.insert("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".into(), "true".into());
    env
}

/// Spawns the CLI in its own process group with piped stdio.
pub fn spawn(program: &Path, args: &[String], cwd: &Path, env: &HashMap<String, String>) -> std::io::Result<Child> {
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
}

pub fn signal_group(pgid: i32, signal: i32) {
    // SAFETY: killpg has no memory-safety preconditions.
    unsafe {
        libc::killpg(pgid, signal);
    }
}

/// True while any process (including an unreaped zombie) remains in the group.
pub fn group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::killpg(pgid, 0) == 0 }
}

/// Blocking wait for every group to empty, up to `grace`; SIGKILLs the survivors.
pub fn reap_groups_blocking(pgids: &[i32], grace: Duration) {
    let deadline = Instant::now() + grace;
    while pgids.iter().any(|&g| group_alive(g)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    for &g in pgids {
        if group_alive(g) {
            signal_group(g, libc::SIGKILL);
        }
    }
}

/// Async variant of [`reap_groups_blocking`] for one group.
pub async fn reap_group(pgid: i32, grace: Duration) {
    let deadline = Instant::now() + grace;
    while group_alive(pgid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if group_alive(pgid) {
        signal_group(pgid, libc::SIGKILL);
    }
}

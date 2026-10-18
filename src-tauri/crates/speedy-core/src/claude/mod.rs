//! U3: one `claude` CLI process per thread, speaking stream-json (KTD4, KTD5, KTD9).
//! The public types here are the IPC contract. `actor.rs` runs one thread (the agent's
//! `host` module owns them). `diff.rs`
//! computes the proposed file change shown with an edit tool's permission request.

pub mod actor;
pub mod diff;
pub mod process;
pub mod protocol;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use diff::FileDiff;

/// Lifecycle status per the plan's state diagram. "finished-unread" is derived by attention.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    #[default]
    NotStarted,
    Starting,
    Idle,
    Working,
    AwaitingUser,
    Crashed,
    Errored,
    Stopped,
}

/// Everything the actor tells the UI, over the thread's Tauri channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeEvent {
    /// One stdout NDJSON line from the CLI, passed through verbatim (KTD4).
    /// Control requests/responses the actor consumes itself are not forwarded here.
    Message { seq: u64, raw: Value },
    /// The `initialize` control_response payload (commands, models, account, …).
    Initialized { seq: u64, response: Value },
    /// The CLI's session id, from `system/init`. The UI persists the thread→session mapping.
    SessionBound { seq: u64, session_id: String },
    Status {
        seq: u64,
        status: ThreadStatus,
        detail: Option<String>,
        /// stderr tail attached on Crashed/Errored.
        stderr_tail: Option<String>,
        /// True while the one automatic `--resume` respawn is in flight.
        reconnecting: bool,
    },
    /// A `can_use_tool` request. `diff` is set for Edit/Write/MultiEdit (KTD5).
    PermissionRequest {
        seq: u64,
        request_id: String,
        request: Value,
        diff: Option<Vec<FileDiff>>,
    },
    /// A pending request was resolved: answered (`allowed`/`denied`), or dropped without an
    /// answer (`interrupt`, `quit`, `stopped`, `cancelled` by the CLI). Every client removes its card.
    PermissionResolved { seq: u64, request_id: String, reason: String },
    /// An allow found the shown diff stale; this is the diff to show instead (KTD5).
    DiffRefreshed { seq: u64, request_id: String, diff: Vec<FileDiff> },
    Stderr { seq: u64, text: String },
    /// A stdout line that never parsed as JSON.
    ProtocolError { seq: u64, line: String },
}

/// Options for `claude_start`. Optional flags are added only when set (KTD4).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub cwd: String,
    pub resume_session_id: Option<String>,
    /// With `resume_session_id`: keep history only up to and including this message uuid (rewind).
    pub resume_session_at: Option<String>,
    /// With `resume_session_id`: continue in a new session id instead of the original (rewind fork).
    pub fork_session: Option<bool>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub max_thinking_tokens: Option<u32>,
}

/// Result of answering a permission request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOutcome {
    /// False when the diff was stale: nothing was sent and `refreshed_diff` holds the new diff.
    pub sent: bool,
    pub refreshed_diff: Option<Vec<FileDiff>>,
}

/// Grace between SIGTERM and SIGKILL when a thread is stopped.
pub const STOP_GRACE: Duration = Duration::from_secs(3);

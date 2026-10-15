//! U3: one `claude` CLI process per thread, speaking stream-json (KTD4, KTD5, KTD9).
//! The public types and commands here are the IPC contract; bodies are STUBS
//! until U3 lands. `diff.rs` is U10's.

pub mod actor;
pub mod diff;
pub mod process;
pub mod protocol;

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

use crate::attention::Attention;
use crate::env::EnvService;

pub use diff::FileDiff;

/// Lifecycle status per the plan's state diagram. "finished-unread" is derived by attention.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
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
    /// A pending request was resolved without the UI (deny on interrupt/quit, or CLI cancel).
    PermissionResolved { seq: u64, request_id: String, reason: String },
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

/// Owns every thread's actor.
pub struct SessionManager {
    #[allow(dead_code)]
    env: Arc<EnvService>,
    #[allow(dead_code)]
    attention: Arc<Attention>,
}

impl SessionManager {
    pub fn new(env: Arc<EnvService>, attention: Arc<Attention>) -> Self {
        SessionManager { env, attention }
    }

    /// KTD9 quit sequence across every actor; blocks up to `grace` before SIGKILL.
    pub fn shutdown_all(&self, _grace: Duration) {}
}

const NOT_IMPLEMENTED: &str = "claude actor not implemented";

/// Spawns the thread's actor if absent (lazy, KTD9), or rebinds the channel if it
/// already runs (webview reload). Returns the current status.
#[tauri::command]
pub async fn claude_start(
    _ctx: tauri::State<'_, crate::AppCtx>,
    _thread_id: String,
    _options: StartOptions,
    _on_event: Channel<ClaudeEvent>,
) -> Result<ThreadStatus, String> {
    Err(NOT_IMPLEMENTED.into())
}

/// Writes a user message. `content` is an Anthropic content-block array (text, image).
#[tauri::command]
pub async fn claude_send_user(
    _ctx: tauri::State<'_, crate::AppCtx>,
    _thread_id: String,
    _content: Value,
) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.into())
}

/// Sends an arbitrary control request (`set_model`, `set_permission_mode`,
/// `set_max_thinking_tokens`, `rewind_files`, `rename_session`, `get_context_usage`, …)
/// and resolves with its response payload, or an error on CLI error or timeout.
#[tauri::command]
pub async fn claude_control(
    _ctx: tauri::State<'_, crate::AppCtx>,
    _thread_id: String,
    _request: Value,
    _timeout_ms: Option<u64>,
) -> Result<Value, String> {
    Err(NOT_IMPLEMENTED.into())
}

/// Answers a `can_use_tool` request. `response` is the SDK PermissionResult
/// (`{behavior:"allow",updatedInput,updatedPermissions?}` or `{behavior:"deny",message}`).
/// For an allow on a request with a diff, the diff is recomputed first (KTD5).
#[tauri::command]
pub async fn claude_respond_permission(
    _ctx: tauri::State<'_, crate::AppCtx>,
    _thread_id: String,
    _request_id: String,
    _response: Value,
) -> Result<PermissionOutcome, String> {
    Err(NOT_IMPLEMENTED.into())
}

/// Denies any pending permission request, then sends `interrupt` (KTD5).
#[tauri::command]
pub async fn claude_interrupt(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: String) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.into())
}

/// Stops the thread's process group (thread closed/archived).
#[tauri::command]
pub async fn claude_stop(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: String) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.into())
}

/// Manual retry after Crashed/Errored: respawns with `--resume` when a session id is known.
#[tauri::command]
pub async fn claude_retry(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: String) -> Result<ThreadStatus, String> {
    Err(NOT_IMPLEMENTED.into())
}

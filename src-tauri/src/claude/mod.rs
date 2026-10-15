//! U3: one `claude` CLI process per thread, speaking stream-json (KTD4, KTD5, KTD9).
//! The public types and commands here are the IPC contract. `actor.rs` runs one
//! thread without Tauri; `SessionManager` maps thread ids to actors. `diff.rs`
//! computes the proposed file change shown with an edit tool's permission request.

pub mod actor;
pub mod diff;
pub mod process;
pub mod protocol;

use std::collections::HashMap;
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

/// Owns every thread's actor.
pub struct SessionManager {
    env: Arc<EnvService>,
    attention: Arc<Attention>,
    actors: parking_lot::Mutex<HashMap<String, actor::ClaudeActor>>,
}

const STOP_GRACE: Duration = Duration::from_secs(3);

impl SessionManager {
    pub fn new(env: Arc<EnvService>, attention: Arc<Attention>) -> Self {
        SessionManager { env, attention, actors: Default::default() }
    }

    fn actor(&self, thread_id: &str) -> Result<actor::ClaudeActor, String> {
        self.actors.lock().get(thread_id).cloned().ok_or_else(|| format!("thread {thread_id} has no claude session"))
    }

    fn sink(channel: Channel<ClaudeEvent>) -> actor::EventSink {
        Arc::new(move |event| {
            let _ = channel.send(event);
        })
    }

    /// Spawns lazily, rebinds the channel of a running actor, or relaunches a stopped one.
    pub async fn start(
        &self,
        thread_id: String,
        options: StartOptions,
        channel: Channel<ClaudeEvent>,
    ) -> Result<ThreadStatus, String> {
        if let Some(existing) = self.actors.lock().get(&thread_id) {
            existing.rebind(Self::sink(channel));
            return Ok(match existing.status() {
                ThreadStatus::Stopped => existing.restart(options),
                status => status,
            });
        }
        let program = self.env.claude_path().await.ok_or("claude CLI not found; finish setup first")?;
        let config = actor::ActorConfig {
            program,
            options,
            env: self.env.env().await.vars,
            extension_settings: self.env.extension_settings(),
        };
        let mut actors = self.actors.lock();
        // Another start for this thread may have won while env was resolving.
        if let Some(existing) = actors.get(&thread_id) {
            existing.rebind(Self::sink(channel));
            return Ok(existing.status());
        }
        let attention = self.attention.clone();
        let id = thread_id.clone();
        let observer: actor::StatusObserver = Arc::new(move |from, to| attention.on_status(&id, "", from, to));
        let actor = actor::ClaudeActor::start(config, Self::sink(channel), observer);
        let status = actor.status();
        actors.insert(thread_id, actor);
        Ok(status)
    }

    /// KTD9 quit sequence across every actor; blocks up to `grace` before SIGKILL.
    pub fn shutdown_all(&self, grace: Duration) {
        let actors: Vec<actor::ClaudeActor> = self.actors.lock().values().cloned().collect();
        actor::shutdown_all(&actors, grace);
    }
}

/// Spawns the thread's actor if absent (lazy, KTD9), or rebinds the channel if it
/// already runs (webview reload). Returns the current status.
#[tauri::command]
pub async fn claude_start(
    ctx: tauri::State<'_, crate::AppCtx>,
    thread_id: String,
    options: StartOptions,
    on_event: Channel<ClaudeEvent>,
) -> Result<ThreadStatus, String> {
    ctx.sessions.start(thread_id, options, on_event).await
}

/// Writes a user message. `content` is an Anthropic content-block array (text, image).
#[tauri::command]
pub async fn claude_send_user(
    ctx: tauri::State<'_, crate::AppCtx>,
    thread_id: String,
    content: Value,
) -> Result<(), String> {
    ctx.sessions.actor(&thread_id)?.send_user(content).await
}

/// Sends an arbitrary control request (`set_model`, `set_permission_mode`,
/// `set_max_thinking_tokens`, `rewind_files`, `rename_session`, `get_context_usage`, …)
/// and resolves with its response payload, or an error on CLI error or timeout.
#[tauri::command]
pub async fn claude_control(
    ctx: tauri::State<'_, crate::AppCtx>,
    thread_id: String,
    request: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let actor = ctx.sessions.actor(&thread_id)?;
    actor.control(request, timeout_ms.map(Duration::from_millis)).await
}

/// Answers a `can_use_tool` request. `response` is the SDK PermissionResult
/// (`{behavior:"allow",updatedInput,updatedPermissions?}` or `{behavior:"deny",message}`).
/// For an allow on a request with a diff, the diff is recomputed first (KTD5).
#[tauri::command]
pub async fn claude_respond_permission(
    ctx: tauri::State<'_, crate::AppCtx>,
    thread_id: String,
    request_id: String,
    response: Value,
) -> Result<PermissionOutcome, String> {
    ctx.sessions.actor(&thread_id)?.respond_permission(&request_id, response).await
}

/// Denies any pending permission request, then sends `interrupt` (KTD5).
#[tauri::command]
pub async fn claude_interrupt(ctx: tauri::State<'_, crate::AppCtx>, thread_id: String) -> Result<(), String> {
    ctx.sessions.actor(&thread_id)?.interrupt().await
}

/// Stops the thread's process group (thread closed/archived).
#[tauri::command]
pub async fn claude_stop(ctx: tauri::State<'_, crate::AppCtx>, thread_id: String) -> Result<(), String> {
    ctx.sessions.actor(&thread_id)?.stop(STOP_GRACE).await;
    Ok(())
}

/// Manual retry after Crashed/Errored: respawns with `--resume` when a session id is known.
#[tauri::command]
pub async fn claude_retry(ctx: tauri::State<'_, crate::AppCtx>, thread_id: String) -> Result<ThreadStatus, String> {
    Ok(ctx.sessions.actor(&thread_id)?.retry())
}

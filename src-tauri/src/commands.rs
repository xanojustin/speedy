//! Thin Tauri command wrappers over `speedy_core`. Names and payloads are the
//! webview's IPC contract; behavior lives in the core.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::ipc::{Channel, InvokeResponseBody};

use speedy_core::claude::{self, ClaudeEvent, PermissionOutcome, StartOptions, ThreadStatus, STOP_GRACE};
use speedy_core::env::SetupState;
use speedy_core::explorer::{DirEntry, GitChange};
use speedy_core::files::FileHit;
use speedy_core::pty::{manager::OutputSink, CLOSE_GRACE};
use speedy_core::state::session_index::{self, SessionMeta};
use speedy_core::state::{self, AppState, LoadResult};
use speedy_core::worktree::{CleanReport, Unused, Worktree};
use speedy_core::{explorer, files, worktree};

use crate::AppCtx;

type Ctx<'a> = tauri::State<'a, AppCtx>;

// ---- env / setup (U2, KTD7) ----

#[tauri::command]
pub async fn get_setup_state(ctx: Ctx<'_>) -> Result<SetupState, String> {
    Ok(ctx.env.setup_state().await)
}

#[tauri::command]
pub async fn recheck_setup(ctx: Ctx<'_>, override_path: Option<String>) -> Result<SetupState, String> {
    Ok(ctx.env.recheck(override_path.map(PathBuf::from)).await)
}

#[tauri::command]
pub fn get_extension_settings(ctx: Ctx<'_>) -> Map<String, Value> {
    ctx.env.extension_settings()
}

// ---- claude (U3) ----

fn claude_sink(channel: Channel<ClaudeEvent>) -> claude::actor::EventSink {
    std::sync::Arc::new(move |event| {
        let _ = channel.send(event);
    })
}

/// Spawns the thread's actor if absent (lazy, KTD9), or rebinds the channel if it
/// already runs (webview reload). Returns the current status.
#[tauri::command]
pub async fn claude_start(
    ctx: Ctx<'_>,
    thread_id: String,
    options: StartOptions,
    on_event: Channel<ClaudeEvent>,
) -> Result<ThreadStatus, String> {
    ctx.sessions.start(thread_id, options, claude_sink(on_event)).await
}

/// Writes a user message. `content` is an Anthropic content-block array (text, image).
#[tauri::command]
pub async fn claude_send_user(ctx: Ctx<'_>, thread_id: String, content: Value) -> Result<(), String> {
    ctx.sessions.actor(&thread_id)?.send_user(content).await
}

/// Sends an arbitrary control request (`set_model`, `set_permission_mode`,
/// `set_max_thinking_tokens`, `rewind_files`, `rename_session`, `get_context_usage`, …)
/// and resolves with its response payload, or an error on CLI error or timeout.
#[tauri::command]
pub async fn claude_control(
    ctx: Ctx<'_>,
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
    ctx: Ctx<'_>,
    thread_id: String,
    request_id: String,
    response: Value,
) -> Result<PermissionOutcome, String> {
    ctx.sessions.actor(&thread_id)?.respond_permission(&request_id, response).await
}

/// Denies any pending permission request, then sends `interrupt` (KTD5).
#[tauri::command]
pub async fn claude_interrupt(ctx: Ctx<'_>, thread_id: String) -> Result<(), String> {
    ctx.sessions.actor(&thread_id)?.interrupt().await
}

/// Stops the thread's process group (thread closed/archived).
#[tauri::command]
pub async fn claude_stop(ctx: Ctx<'_>, thread_id: String) -> Result<(), String> {
    ctx.sessions.actor(&thread_id)?.stop(STOP_GRACE).await;
    Ok(())
}

/// Manual retry after Crashed/Errored: respawns with `--resume` when a session id is known.
#[tauri::command]
pub async fn claude_retry(ctx: Ctx<'_>, thread_id: String) -> Result<ThreadStatus, String> {
    Ok(ctx.sessions.actor(&thread_id)?.retry())
}

// ---- pty (U4) ----

/// Opens the terminal's shell if absent, or rebinds `on_data` if it already runs.
/// Output arrives on `on_data` as raw bytes (ArrayBuffer in JS), coalesced per KTD3.
#[tauri::command]
pub async fn pty_open(
    ctx: Ctx<'_>,
    terminal_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let sink: OutputSink = Box::new(move |bytes| {
        let _ = on_data.send(InvokeResponseBody::Raw(bytes));
    });
    ctx.ptys.open(&terminal_id, &cwd, cols, rows, sink).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_write(ctx: Ctx<'_>, terminal_id: String, data: String) -> Result<(), String> {
    ctx.ptys.host.write(&terminal_id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ctx: Ctx<'_>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    ctx.ptys.host.resize(&terminal_id, cols, rows).map_err(|e| e.to_string())
}

/// Returns immediately; the shell's process groups get SIGHUP, then SIGKILL after a grace.
#[tauri::command]
pub fn pty_close(ctx: Ctx<'_>, terminal_id: String) -> Result<(), String> {
    ctx.ptys.host.close(&terminal_id, CLOSE_GRACE);
    Ok(())
}

/// True when the shell has a foreground child (Cmd+W confirmation, U6).
#[tauri::command]
pub fn pty_has_foreground_child(ctx: Ctx<'_>, terminal_id: String) -> bool {
    ctx.ptys.host.has_foreground_child(&terminal_id)
}

// ---- state and session history (U5, U11) ----

#[tauri::command]
pub fn state_load(ctx: Ctx<'_>) -> LoadResult {
    state::load_with_chats(&ctx.store)
}

/// Debounced, atomic save of the whole app state.
#[tauri::command]
pub fn state_save(ctx: Ctx<'_>, state: AppState) {
    ctx.store.save(state);
}

#[tauri::command]
pub async fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    state::paths_exist(paths).await
}

#[tauri::command]
pub async fn sessions_list(project_path: String) -> Result<Vec<SessionMeta>, String> {
    session_index::sessions_list(project_path).await
}

/// Every parseable JSONL line of a session, in order, for seeding a resumed transcript
/// and for finding a rewind's fork point (which walks the `parentUuid` chain through all lines).
#[tauri::command]
pub async fn session_load(project_path: String, session_id: String) -> Result<Vec<Value>, String> {
    session_index::session_load(project_path, session_id).await
}

/// Appends a `custom-title` entry in the CLI's own format (no live actor).
#[tauri::command]
pub async fn session_rename_offline(project_path: String, session_id: String, title: String) -> Result<(), String> {
    session_index::session_rename_offline(project_path, session_id, title).await
}

// ---- files, explorer, worktrees ----

#[tauri::command]
pub async fn files_search(
    root: String,
    query: String,
    limit: Option<usize>,
    respect_gitignore: Option<bool>,
) -> Result<Vec<FileHit>, String> {
    files::files_search(root, query, limit, respect_gitignore).await
}

#[tauri::command]
pub async fn explorer_list(root: String, dir: String) -> Result<Vec<DirEntry>, String> {
    explorer::explorer_list(root, dir).await
}

#[tauri::command]
pub async fn explorer_read(root: String, path: String) -> Result<String, String> {
    explorer::explorer_read(root, path).await
}

#[tauri::command]
pub async fn explorer_write(root: String, path: String, content: String) -> Result<(), String> {
    explorer::explorer_write(root, path, content).await
}

#[tauri::command]
pub async fn explorer_git_status(root: String) -> Result<Vec<GitChange>, String> {
    explorer::explorer_git_status(root).await
}

#[tauri::command]
pub async fn explorer_git_branch(root: String) -> Result<Option<String>, String> {
    explorer::explorer_git_branch(root).await
}

#[tauri::command]
pub async fn explorer_git_diff(root: String, path: String) -> Result<speedy_core::claude::FileDiff, String> {
    explorer::explorer_git_diff(root, path).await
}

#[tauri::command]
pub async fn worktree_create(root: String, branch: String) -> Result<Worktree, String> {
    worktree::worktree_create(root, branch).await
}

#[tauri::command]
pub async fn worktree_unused(root: String, keep: Vec<String>) -> Result<Vec<Unused>, String> {
    worktree::worktree_unused(root, keep).await
}

#[tauri::command]
pub async fn worktree_clean(root: String, paths: Vec<String>) -> Result<CleanReport, String> {
    worktree::worktree_clean(root, paths).await
}

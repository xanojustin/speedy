//! U4: one login-shell PTY per thread with coalesced binary output (KTD3, KTD9).
//! Types and commands are the IPC contract; bodies are STUBS until U4 lands.

pub mod coalesce;
pub mod manager;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;

use crate::env::EnvService;

/// Emitted as the app event `pty-exit` when a thread's shell exits.
pub const PTY_EXIT_EVENT: &str = "pty-exit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub thread_id: String,
    pub code: Option<i32>,
}

pub struct PtyManager {
    #[allow(dead_code)]
    env: Arc<EnvService>,
    #[allow(dead_code)]
    app: AppHandle,
}

impl PtyManager {
    pub fn new(env: Arc<EnvService>, app: AppHandle) -> Self {
        PtyManager { env, app }
    }

    /// SIGHUP every PTY's process group, SIGKILL after `grace` (KTD9).
    pub fn shutdown_all(&self, _grace: Duration) {}
}

const NOT_IMPLEMENTED: &str = "pty manager not implemented";

/// Opens the thread's shell if absent, or rebinds `on_data` if it already runs.
/// Output arrives on `on_data` as raw bytes (ArrayBuffer in JS), coalesced per KTD3.
#[tauri::command]
pub async fn pty_open(
    _ctx: tauri::State<'_, crate::AppCtx>,
    _thread_id: String,
    _cwd: String,
    _cols: u16,
    _rows: u16,
    _on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.into())
}

#[tauri::command]
pub fn pty_write(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: String, _data: String) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.into())
}

#[tauri::command]
pub fn pty_resize(
    _ctx: tauri::State<'_, crate::AppCtx>,
    _thread_id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.into())
}

#[tauri::command]
pub fn pty_close(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: String) -> Result<(), String> {
    Err(NOT_IMPLEMENTED.into())
}

/// True when the shell has a foreground child (Cmd+W confirmation, U6).
#[tauri::command]
pub fn pty_has_foreground_child(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: String) -> bool {
    false
}

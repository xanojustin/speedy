//! U4: login-shell PTYs (a thread can have several terminals) with coalesced binary output (KTD3, KTD9).
//! Types and commands are the IPC contract; the Tauri-free core is in `manager`.

pub mod coalesce;
pub mod manager;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::env::EnvService;

/// Emitted as the app event `pty-exit` when a terminal's shell exits.
pub const PTY_EXIT_EVENT: &str = "pty-exit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub terminal_id: String,
    pub code: Option<i32>,
}

/// Grace between SIGHUP and SIGKILL when a terminal is closed.
const CLOSE_GRACE: Duration = Duration::from_secs(3);

pub struct PtyManager {
    env: Arc<EnvService>,
    host: manager::PtyHost,
}

impl PtyManager {
    pub fn new(env: Arc<EnvService>, app: AppHandle) -> Self {
        let host = manager::PtyHost::new(move |exit: PtyExit| {
            if let Err(e) = app.emit(PTY_EXIT_EVENT, exit) {
                log::warn!("emitting {PTY_EXIT_EVENT}: {e}");
            }
        });
        PtyManager { env, host }
    }

    /// Starts `$SHELL -l` in `cwd` with the resolved login env, or rebinds output.
    pub async fn open(
        &self,
        terminal_id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        on_data: Channel<InvokeResponseBody>,
    ) -> anyhow::Result<()> {
        let resolved = self.env.env().await;
        // Until the login env is resolved (or if it failed), use the process env.
        let env: HashMap<String, String> =
            if resolved.vars.is_empty() { std::env::vars().collect() } else { resolved.vars };
        let spec = manager::PtySpawn { shell: manager::login_shell(&env), cwd: cwd.into(), env, cols, rows };
        let sink: manager::OutputSink = Box::new(move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes));
        });
        self.host.open(terminal_id, spec, sink)
    }

    /// SIGHUP every PTY's process group, SIGKILL after `grace` (KTD9).
    pub fn shutdown_all(&self, grace: Duration) {
        self.host.shutdown_all(grace);
    }
}

/// Opens the terminal's shell if absent, or rebinds `on_data` if it already runs.
/// Output arrives on `on_data` as raw bytes (ArrayBuffer in JS), coalesced per KTD3.
#[tauri::command]
pub async fn pty_open(
    ctx: tauri::State<'_, crate::AppCtx>,
    terminal_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    ctx.ptys.open(&terminal_id, &cwd, cols, rows, on_data).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_write(ctx: tauri::State<'_, crate::AppCtx>, terminal_id: String, data: String) -> Result<(), String> {
    ctx.ptys.host.write(&terminal_id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    ctx: tauri::State<'_, crate::AppCtx>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ctx.ptys.host.resize(&terminal_id, cols, rows).map_err(|e| e.to_string())
}

/// Returns immediately; the shell's process groups get SIGHUP, then SIGKILL after a grace.
#[tauri::command]
pub fn pty_close(ctx: tauri::State<'_, crate::AppCtx>, terminal_id: String) -> Result<(), String> {
    ctx.ptys.host.close(&terminal_id, CLOSE_GRACE);
    Ok(())
}

/// True when the shell has a foreground child (Cmd+W confirmation, U6).
#[tauri::command]
pub fn pty_has_foreground_child(ctx: tauri::State<'_, crate::AppCtx>, terminal_id: String) -> bool {
    ctx.ptys.host.has_foreground_child(&terminal_id)
}

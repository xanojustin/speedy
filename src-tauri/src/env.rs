//! U2: login-shell environment capture, `claude` discovery, setup state, and the
//! extension's `claudeCode.*` settings (KTD7). STUB — implemented by U2.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

/// The CLI version the protocol fixtures were recorded against (KTD7 skew warning).
pub const FIXTURE_CLI_VERSION: &str = "2.1.296 (Claude Code)";

/// Environment captured from `$SHELL -l -i -c env`, used for every child process.
#[derive(Debug, Clone, Default)]
pub struct ResolvedEnv {
    pub vars: HashMap<String, String>,
    /// True when the login shell timed out or failed and the fallback env was used.
    pub degraded: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupStatus {
    Resolving,
    Ready,
    CliNotFound,
    NotLoggedIn,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub status: SetupStatus,
    pub claude_path: Option<String>,
    pub claude_version: Option<String>,
    pub fixture_version: String,
    /// True when the installed CLI version differs at all from `FIXTURE_CLI_VERSION`.
    pub version_mismatch: bool,
    pub searched_paths: Vec<String>,
    pub env_degraded: bool,
    /// Human-readable guidance for the setup screen.
    pub message: Option<String>,
}

/// Owns the resolved env and setup state. `start()` kicks off resolution on a
/// background thread; readers block (async) until it's done.
pub struct EnvService {}

impl EnvService {
    pub fn start() -> Self {
        EnvService {}
    }

    /// Resolved env for child processes (waits for resolution).
    pub async fn env(&self) -> ResolvedEnv {
        ResolvedEnv::default()
    }

    /// Resolved `claude` binary path, if found.
    pub async fn claude_path(&self) -> Option<PathBuf> {
        None
    }

    pub async fn setup_state(&self) -> SetupState {
        SetupState {
            status: SetupStatus::Error,
            claude_path: None,
            claude_version: None,
            fixture_version: FIXTURE_CLI_VERSION.into(),
            version_mismatch: false,
            searched_paths: vec![],
            env_degraded: false,
            message: Some("env resolver not implemented".into()),
        }
    }

    /// Re-runs discovery and auth checks (after the user fixes their install).
    pub async fn recheck(&self, _override_path: Option<PathBuf>) -> SetupState {
        self.setup_state().await
    }

    /// Effective `claudeCode.*` settings: extension defaults overlaid with the
    /// user's VS Code `settings.json`. Keys keep their full `claudeCode.` names.
    pub fn extension_settings(&self) -> Map<String, Value> {
        Map::new()
    }
}

/// Captures the login-shell environment with a timeout, falling back to the
/// process env plus common paths.
pub fn capture_login_env(_shell: &str, _timeout: Duration) -> ResolvedEnv {
    ResolvedEnv::default()
}

#[tauri::command]
pub async fn get_setup_state(ctx: tauri::State<'_, crate::AppCtx>) -> Result<SetupState, String> {
    Ok(ctx.env.setup_state().await)
}

#[tauri::command]
pub async fn recheck_setup(
    ctx: tauri::State<'_, crate::AppCtx>,
    override_path: Option<String>,
) -> Result<SetupState, String> {
    Ok(ctx.env.recheck(override_path.map(PathBuf::from)).await)
}

#[tauri::command]
pub fn get_extension_settings(ctx: tauri::State<'_, crate::AppCtx>) -> Map<String, Value> {
    ctx.env.extension_settings()
}

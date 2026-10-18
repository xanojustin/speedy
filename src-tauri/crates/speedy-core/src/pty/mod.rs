//! U4: login-shell PTYs (a thread can have several terminals) with coalesced binary output (KTD3, KTD9).
//! Types are the IPC contract; the PTY host itself is in `manager`.

pub mod coalesce;
pub mod manager;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::env::EnvService;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub terminal_id: String,
    pub code: Option<i32>,
}

/// Grace between SIGHUP and SIGKILL when a terminal is closed.
pub const CLOSE_GRACE: Duration = Duration::from_secs(3);

pub struct PtyManager {
    env: Arc<EnvService>,
    pub host: manager::PtyHost,
}

impl PtyManager {
    /// `on_exit` runs when a terminal's shell exits.
    pub fn new(env: Arc<EnvService>, on_exit: impl Fn(PtyExit) + Send + Sync + 'static) -> Self {
        PtyManager { env, host: manager::PtyHost::new(on_exit) }
    }

    /// Starts `$SHELL -l` in `cwd` with the resolved login env, or rebinds output.
    pub async fn open(
        &self,
        terminal_id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        sink: manager::OutputSink,
    ) -> anyhow::Result<()> {
        let resolved = self.env.env().await;
        // Until the login env is resolved (or if it failed), use the process env.
        let env: HashMap<String, String> =
            if resolved.vars.is_empty() { std::env::vars().collect() } else { resolved.vars };
        let spec = manager::PtySpawn { shell: manager::login_shell(&env), cwd: cwd.into(), env, cols, rows };
        self.host.open(terminal_id, spec, sink)
    }

    /// SIGHUP every PTY's process group, SIGKILL after `grace` (KTD9).
    pub fn shutdown_all(&self, grace: Duration) {
        self.host.shutdown_all(grace);
    }
}

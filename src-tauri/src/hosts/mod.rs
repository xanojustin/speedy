//! U8: the app's hosts (KTD3, KTD11, KTD14). The webview never touches the network: it calls
//! these commands with a host key, and the app's Rust side holds one [`HostConn`] per host and
//! forwards RPCs and subscriptions over it. RPC names and params are the agent's, which match
//! the old in-process Tauri commands. This Mac is the host key [`LOCAL`].

pub mod connection;
pub mod local;
pub mod status;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use speedy_agent::paths::AgentPaths;
use speedy_core::claude::ThreadStatus;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::net::UnixStream;

use connection::{ConnState, Connector, HostConn, Stream};
use local::Upgrade;
use status::StatusTracker;

/// This Mac's host key.
pub const LOCAL: &str = "local";
/// How often a pending upgrade checks whether the agent has gone idle.
const UPGRADE_RECHECK: Duration = Duration::from_secs(30);

/// Called on every live thread status transition: `(thread_id, from, to)`.
pub type TransitionFn = Arc<dyn Fn(&str, ThreadStatus, ThreadStatus) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub key: String,
    pub state: ConnState,
    /// This Mac only: the bundled agent is newer and waits for the running one to go idle.
    pub update: Option<&'static str>,
}

pub struct HostRegistry {
    hosts: Mutex<HashMap<String, Arc<HostConn>>>,
    local_update: Mutex<Option<&'static str>>,
}

impl HostRegistry {
    pub fn new() -> Arc<HostRegistry> {
        Arc::new(HostRegistry { hosts: Mutex::default(), local_update: Mutex::default() })
    }

    pub fn get(&self, key: &str) -> Result<Arc<HostConn>, String> {
        self.hosts.lock().get(key).cloned().ok_or_else(|| format!("no host {key}"))
    }

    pub fn list(&self) -> Vec<HostInfo> {
        let update = *self.local_update.lock();
        self.hosts
            .lock()
            .iter()
            .map(|(key, conn)| HostInfo { key: key.clone(), state: conn.state(), update: (key == LOCAL).then_some(update).flatten() })
            .collect()
    }

    /// Adds a host, feeding its live status transitions to `on_transition`.
    pub fn add(&self, key: &str, connector: Connector, on_transition: TransitionFn) -> Arc<HostConn> {
        let conn = HostConn::start(connector);
        let tracker = Mutex::new(StatusTracker::default());
        conn.subscribe_host(Arc::new(move |event| {
            if let Some((id, from, to)) = tracker.lock().observe(&event) {
                on_transition(&id, from, to);
            }
        }));
        self.hosts.lock().insert(key.to_owned(), conn.clone());
        conn
    }

    /// Connects to This Mac's agent, installing or upgrading the bundled build first (KTD9).
    pub fn start_local(self: &Arc<Self>, on_transition: TransitionFn) {
        let paths = AgentPaths::from_env();
        let socket = paths.socket();
        let connector: Connector = Arc::new(move || {
            let socket = socket.clone();
            Box::pin(async move {
                let stream = UnixStream::connect(&socket).await.map_err(|e| format!("This Mac's agent isn't running ({e})"))?;
                Ok(Box::new(stream) as Box<dyn Stream>)
            })
        });
        let conn = self.add(LOCAL, connector, on_transition);
        let registry = self.clone();
        tokio::spawn(async move {
            loop {
                let decision = match bootstrap_local(&paths, &conn).await {
                    Ok(decision) => decision,
                    Err(e) => {
                        log::error!("starting This Mac's agent: {e}");
                        return;
                    }
                };
                *registry.local_update.lock() = match decision {
                    Upgrade::Pending => Some("pending"),
                    Upgrade::Blocked => Some("blocked"),
                    Upgrade::UpToDate | Upgrade::Install => None,
                };
                if matches!(decision, Upgrade::UpToDate | Upgrade::Install) {
                    return;
                }
                tokio::time::sleep(UPGRADE_RECHECK).await;
            }
        });
    }
}

/// One pass of the KTD9 rule for This Mac: install now, or report why not.
async fn bootstrap_local(paths: &AgentPaths, conn: &HostConn) -> Result<Upgrade, String> {
    let bundled = local::bundled_agent().map_err(|e| e.to_string())?;
    let build = local::inspect(&bundled).map_err(|e| e.to_string())?;
    let installed = local::inspect(&local::current_agent(paths)).ok();
    let running = speedy_agent::daemon::agent_running(paths);
    let busy = running && agent_busy(conn).await;
    let decision = local::decide(installed.as_ref(), &build, running, busy);
    if decision == Upgrade::Install {
        let paths = paths.clone();
        tokio::task::spawn_blocking(move || local::stage(&paths, &bundled, &build).and_then(|staged| local::install(&staged)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("installing the agent: {e}"))?;
        conn.reconnect_now();
    }
    Ok(decision)
}

/// Asks the running agent; assumes busy when it can't be asked, so nothing gets interrupted.
async fn agent_busy(conn: &HostConn) -> bool {
    let mut state = conn.watch();
    let wait = state.wait_for(|s| matches!(s, ConnState::Connected { .. }));
    let connected = matches!(tokio::time::timeout(Duration::from_secs(5), wait).await, Ok(Ok(_)));
    if !connected {
        return true;
    }
    conn.call("agent_busy", Value::Null).await.ok().and_then(|v| v.as_bool()).unwrap_or(true)
}

// ---- Tauri commands ----

type Hosts<'a> = tauri::State<'a, Arc<HostRegistry>>;

#[tauri::command]
pub fn host_list(hosts: Hosts<'_>) -> Vec<HostInfo> {
    hosts.list()
}

/// Forwards one RPC: `method` and `params` are the agent's (the old command names and args).
#[tauri::command]
pub async fn host_call(hosts: Hosts<'_>, host: String, method: String, params: Value) -> Result<Value, String> {
    hosts.get(&host)?.call(&method, params).await
}

/// Host events: a `host_snapshot` on every (re)connect, then upserts and status changes.
#[tauri::command]
pub fn host_subscribe(hosts: Hosts<'_>, host: String, on_event: Channel<Value>) -> Result<u64, String> {
    Ok(hosts.get(&host)?.subscribe_host(Arc::new(move |e| {
        let _ = on_event.send(e);
    })))
}

/// A thread's events, continuous across reconnects (a `snapshot` event when the agent can't replay).
#[tauri::command]
pub fn host_thread_subscribe(hosts: Hosts<'_>, host: String, thread_id: String, on_event: Channel<Value>) -> Result<u64, String> {
    Ok(hosts.get(&host)?.subscribe_thread(&thread_id, Arc::new(move |e| {
        let _ = on_event.send(e);
    })))
}

/// Attaches to a terminal (starting its shell if absent): raw output on `on_data`, `pty_exit` on `on_exit`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn host_pty_attach(
    hosts: Hosts<'_>,
    host: String,
    terminal_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Value>,
) -> Result<u64, String> {
    let output = Arc::new(move |bytes: Vec<u8>| {
        let _ = on_data.send(InvokeResponseBody::Raw(bytes));
    });
    let exit = Arc::new(move |e: Value| {
        let _ = on_exit.send(e);
    });
    Ok(hosts.get(&host)?.attach_terminal(&terminal_id, &cwd, cols, rows, output, exit))
}

#[tauri::command]
pub async fn host_pty_resize(hosts: Hosts<'_>, host: String, terminal_id: String, cols: u16, rows: u16) -> Result<Value, String> {
    let conn = hosts.get(&host)?;
    conn.note_terminal_size(&terminal_id, cols, rows);
    conn.call("pty_resize", serde_json::json!({"terminalId": terminal_id, "cols": cols, "rows": rows})).await
}

#[tauri::command]
pub fn host_unsubscribe(hosts: Hosts<'_>, host: String, sub_id: u64) -> Result<(), String> {
    hosts.get(&host)?.unsubscribe(sub_id);
    Ok(())
}

/// The host's connection state now, then every change.
#[tauri::command]
pub fn host_watch(hosts: Hosts<'_>, host: String, on_state: Channel<ConnState>) -> Result<(), String> {
    let mut rx = hosts.get(&host)?.watch();
    tokio::spawn(async move {
        loop {
            let state = rx.borrow_and_update().clone();
            if on_state.send(state).is_err() || rx.changed().await.is_err() {
                return;
            }
        }
    });
    Ok(())
}

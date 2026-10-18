//! U8: the app's hosts (KTD3, KTD11, KTD14). The webview never touches the network: it calls
//! these commands with a host key, and the app's Rust side holds one [`HostConn`] per host and
//! forwards RPCs and subscriptions over it. RPC names and params are the agent's. This Mac is
//! the host key [`LOCAL`].

pub mod askpass;
pub mod bootstrap;
pub mod connection;
pub mod local;
pub mod ssh;
pub mod ssh_config;
pub mod status;
pub mod wake;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use speedy_agent::paths::AgentPaths;
use speedy_core::claude::ThreadStatus;
use speedy_core::state::default_state_dir;
use speedy_core::state::store::{JsonStore, StoredState};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::net::UnixStream;

use askpass::Askpass;
use bootstrap::Step;
use connection::{ConnState, Connector, HostConn, Stream};
use local::{Installed, Upgrade};
use ssh::{REMOTE_AGENT, Ssh};
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
    /// The bundled agent is newer and waits for the running one to go idle ("pending"), or
    /// can't talk to this app while it's busy ("blocked").
    pub update: Option<&'static str>,
}

/// The SSH hosts the user added, by alias, in `hosts.json` next to `client.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostList {
    pub version: u32,
    pub ssh: Vec<String>,
}

impl StoredState for HostList {
    const FILE: &'static str = "hosts.json";
    fn stamp_version(&mut self) {
        self.version = 1;
    }
}

pub struct HostRegistry {
    hosts: Mutex<HashMap<String, Arc<HostConn>>>,
    ssh: Mutex<HashMap<String, Arc<Ssh>>>,
    updates: Mutex<HashMap<String, &'static str>>,
    list: JsonStore<HostList>,
    on_transition: Mutex<Option<TransitionFn>>,
    askpass: Mutex<Option<Arc<Askpass>>>,
    /// Working threads per host, for the quit notice.
    working: Mutex<HashMap<String, Vec<String>>>,
}

impl HostRegistry {
    pub fn new() -> Arc<HostRegistry> {
        Self::new_in(default_state_dir())
    }

    /// A registry keeping `hosts.json` in `state_dir` (tests use a temporary one).
    pub fn new_in(state_dir: std::path::PathBuf) -> Arc<HostRegistry> {
        Arc::new(HostRegistry {
            hosts: Mutex::default(),
            ssh: Mutex::default(),
            updates: Mutex::default(),
            list: JsonStore::new(state_dir),
            on_transition: Mutex::default(),
            askpass: Mutex::default(),
            working: Mutex::default(),
        })
    }

    pub fn set_askpass(&self, askpass: Arc<Askpass>) {
        *self.askpass.lock() = Some(askpass);
    }

    pub fn askpass(&self) -> Option<Arc<Askpass>> {
        self.askpass.lock().clone()
    }

    pub fn get(&self, key: &str) -> Result<Arc<HostConn>, String> {
        self.hosts.lock().get(key).cloned().ok_or_else(|| format!("no host {key}"))
    }

    pub fn list(&self) -> Vec<HostInfo> {
        let updates = self.updates.lock().clone();
        let mut hosts: Vec<HostInfo> = self
            .hosts
            .lock()
            .iter()
            .map(|(key, conn)| HostInfo { key: key.clone(), state: conn.state(), update: updates.get(key).copied() })
            .collect();
        // This Mac first, then the SSH hosts in the order they were added.
        let order = self.list.load().state.ssh;
        hosts.sort_by_key(|h| if h.key == LOCAL { 0 } else { 1 + order.iter().position(|a| *a == h.key).unwrap_or(usize::MAX - 1) });
        hosts
    }

    fn transition(&self) -> TransitionFn {
        self.on_transition.lock().clone().unwrap_or_else(|| Arc::new(|_, _, _| {}))
    }

    /// Reconnects the SSH hosts the user added before. They connect without prompting; one
    /// that needs a passphrase waits for the user's Reconnect.
    pub fn start_saved(self: &Arc<Self>) {
        let configured = ssh_config::aliases(&ssh_config::user_config());
        for alias in self.list.load().state.ssh {
            if ssh::valid_alias(&alias, &configured) {
                self.connect_ssh(&alias, false);
            } else {
                log::warn!("skipping saved host {alias:?}: it's no longer a Host in ~/.ssh/config");
            }
        }
    }

    /// Adds an SSH host from `~/.ssh/config`. A user-initiated connect may prompt (askpass).
    pub fn add_ssh(self: &Arc<Self>, alias: &str) -> Result<Arc<HostConn>, String> {
        if !ssh::valid_alias(alias, &ssh_config::aliases(&ssh_config::user_config())) {
            return Err(format!("{alias:?} isn't a Host in ~/.ssh/config"));
        }
        let mut list = self.list.load().state;
        if !list.ssh.iter().any(|a| a == alias) {
            list.ssh.push(alias.to_owned());
            self.list.save(list);
        }
        Ok(self.connect_ssh(alias, true))
    }

    /// Forgets an SSH host: closes its connection (ending its reconnects and upgrade watch)
    /// and its master. Its agent keeps running there.
    pub async fn remove(&self, key: &str) {
        let conn = self.hosts.lock().remove(key);
        if let Some(conn) = conn {
            conn.close();
        }
        self.updates.lock().remove(key);
        self.working.lock().remove(key);
        let ssh = self.ssh.lock().remove(key);
        if let Some(ssh) = ssh {
            ssh.drop_master().await;
        }
        let mut list = self.list.load().state;
        list.ssh.retain(|a| a != key);
        self.list.save(list);
    }

    /// A user-initiated reconnect: a fresh master that may prompt.
    pub async fn reconnect(&self, key: &str) -> Result<(), String> {
        let conn = self.get(key)?;
        let ssh = self.ssh.lock().get(key).cloned();
        if let Some(ssh) = ssh {
            ssh.allow_prompts(self.askpass().map(|a| a.env_for(key)));
            ssh.drop_master().await;
        }
        conn.reconnect_now();
        Ok(())
    }

    /// How many of `key`'s threads are working right now.
    pub fn working(&self, key: &str) -> usize {
        self.working.lock().get(key).map_or(0, |w| w.len())
    }

    /// Stops This Mac's agent and its threads and shells, on request (R17).
    pub async fn stop_local(&self) -> Result<(), String> {
        let agent = local::current_agent(&AgentPaths::from_env());
        let out = tokio::process::Command::new(&agent).arg("stop").output().await.map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) }
    }

    /// Starts This Mac's agent again after a stop. One that is already running and busy is
    /// left as it is.
    pub async fn start_local_again(&self) -> Result<(), String> {
        let agent = local::current_agent(&AgentPaths::from_env());
        let out = tokio::process::Command::new(&agent).arg("install").output().await.map_err(|e| e.to_string())?;
        Installed::from_exit(out.status, &out.stderr)?;
        self.get(LOCAL)?.reconnect_now();
        Ok(())
    }

    /// The Mac woke: masters that survived sleep may hang, so every host starts over.
    pub async fn woke(&self) {
        let ssh: Vec<Arc<Ssh>> = self.ssh.lock().values().cloned().collect();
        // Concurrently: a master that survived sleep can hang until ssh gives up on it.
        let mut drops = tokio::task::JoinSet::new();
        for s in ssh {
            drops.spawn(async move { s.drop_master().await });
        }
        drops.join_all().await;
        let conns: Vec<Arc<HostConn>> = self.hosts.lock().values().cloned().collect();
        for conn in conns {
            conn.reconnect_now();
        }
    }

    fn connect_ssh(self: &Arc<Self>, alias: &str, interactive: bool) -> Arc<HostConn> {
        if let Some(conn) = self.hosts.lock().get(alias) {
            return conn.clone();
        }
        let ssh = Arc::new(Ssh::new(alias));
        if interactive {
            ssh.allow_prompts(self.askpass().map(|a| a.env_for(alias)));
        }
        self.ssh.lock().insert(alias.to_owned(), ssh.clone());
        let conn = self.add(alias, ssh_connector(ssh.clone()), self.transition());
        let (registry, key, watched) = (self.clone(), alias.to_owned(), conn.clone());
        tokio::spawn(async move { registry.keep_updated(&key, &watched, &ssh).await });
        conn
    }

    /// Swaps in the bundled agent once the host's older one is idle (KTD9). Ends when the
    /// host is removed.
    async fn keep_updated(&self, key: &str, conn: &HostConn, ssh: &Ssh) {
        tokio::select! {
            _ = conn.closed() => {}
            _ = self.watch_upgrades(key, conn, ssh) => {}
        }
    }

    async fn watch_upgrades(&self, key: &str, conn: &HostConn, ssh: &Ssh) {
        let mut state = conn.watch();
        loop {
            if state.wait_for(|s| matches!(s, ConnState::Connected { .. })).await.is_err() {
                return;
            }
            let decision = match ssh_upgrade(ssh, conn).await {
                Ok(decision) => decision,
                Err(e) => {
                    // A failed probe or upload is retried rather than given up on for good.
                    log::warn!("checking {key}'s agent: {e}");
                    tokio::time::sleep(UPGRADE_RECHECK).await;
                    continue;
                }
            };
            if !self.set_update(key, decision) {
                // Watch again after the next reconnect (the install restarts the agent).
                if state.wait_for(|s| !matches!(s, ConnState::Connected { .. })).await.is_err() {
                    return;
                }
                continue;
            }
            tokio::time::sleep(UPGRADE_RECHECK).await;
        }
    }

    /// Records whether `key`'s agent waits for a swap; true while it does.
    fn set_update(&self, key: &str, decision: Upgrade) -> bool {
        let label = decision.label();
        let mut updates = self.updates.lock();
        match label {
            Some(label) => {
                updates.insert(key.to_owned(), label);
            }
            None => {
                updates.remove(key);
            }
        }
        label.is_some()
    }

    /// Adds a host, feeding its live status transitions to `on_transition`.
    pub fn add(self: &Arc<Self>, key: &str, connector: Connector, on_transition: TransitionFn) -> Arc<HostConn> {
        let conn = HostConn::start(connector);
        let tracker = Mutex::new(StatusTracker::default());
        let (registry, host) = (Arc::downgrade(self), key.to_owned());
        conn.subscribe_host(Arc::new(move |event| {
            let mut tracker = tracker.lock();
            if let Some((id, from, to)) = tracker.observe(&event) {
                on_transition(&id, from, to);
            }
            if let Some(registry) = registry.upgrade() {
                registry.working.lock().insert(host.clone(), tracker.working());
            }
        }));
        self.hosts.lock().insert(key.to_owned(), conn.clone());
        conn
    }

    /// Connects to This Mac's agent, installing or upgrading the bundled build first (KTD9).
    pub fn start_local(self: &Arc<Self>, on_transition: TransitionFn) {
        *self.on_transition.lock() = Some(on_transition.clone());
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
                        // Retried: a failed install (disk full, a stale lock) can clear up.
                        log::error!("starting This Mac's agent: {e}");
                        tokio::time::sleep(UPGRADE_RECHECK).await;
                        continue;
                    }
                };
                if !registry.set_update(LOCAL, decision) {
                    return;
                }
                tokio::time::sleep(UPGRADE_RECHECK).await;
            }
        });
    }
}

/// One pass of the KTD9 rule for This Mac: install now, or report why not.
async fn bootstrap_local(paths: &AgentPaths, conn: &HostConn) -> Result<Upgrade, String> {
    let (bundled, build) = bootstrap::bundled()?;
    let installed = local::inspect(&local::current_agent(paths)).ok();
    let running = speedy_agent::daemon::agent_running(paths);
    // Busy only matters when the running agent is a different build.
    let same = installed.as_ref().is_some_and(|i| i.sha256 == build.sha256);
    let busy = running && !same && agent_busy(conn).await;
    let decision = local::decide(installed.as_ref(), &build, running, busy);
    let installed_now = match decision {
        Upgrade::Install => {
            let (paths, build) = (paths.clone(), build.clone());
            tokio::task::spawn_blocking(move || local::stage(&paths, &bundled, &build).and_then(|staged| local::install(&staged)))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("installing the agent: {e}"))?
        }
        Upgrade::Start => {
            // A newer agent another Speedy installed: start it as it is.
            let current = local::current_agent(paths);
            tokio::task::spawn_blocking(move || local::install(&current))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("starting the agent: {e}"))?
        }
        Upgrade::UpToDate | Upgrade::Pending | Upgrade::Blocked => return Ok(decision),
    };
    Ok(after_install(decision, installed_now, installed.as_ref(), &build, conn))
}

/// The decision once `install` ran. Work can start between our busy check and the swap, so
/// the agent checks again itself; when it says busy, the update waits (KTD9).
fn after_install(decision: Upgrade, done: Installed, installed: Option<&local::Build>, bundled: &local::Build, conn: &HostConn) -> Upgrade {
    match (done, decision) {
        (Installed::Started, _) => {
            conn.reconnect_now();
            decision
        }
        // Whatever runs is the newer build `Start` meant to start.
        (Installed::Busy, Upgrade::Start) => Upgrade::UpToDate,
        (Installed::Busy, _) => local::deferred(installed, bundled),
    }
}

/// Opens a stream to an SSH host's agent, installing or starting it first when needed. Only
/// the first master after a user-initiated connect may prompt.
fn ssh_connector(ssh: Arc<Ssh>) -> Connector {
    Arc::new(move || {
        let ssh = ssh.clone();
        Box::pin(async move {
            let started = ssh.ensure_master().await;
            ssh.allow_prompts(None);
            started?;
            let (binary, build) = bootstrap::bundled()?;
            let probe = bootstrap::probe(&ssh).await?;
            // An agent that started since the probe and is busy keeps running; connect to it.
            match bootstrap::plan(&probe, &build, &bootstrap::bundled_archs(&binary))? {
                Step::Upload => {
                    bootstrap::upload_and_install(&ssh, &binary, &build).await?;
                }
                Step::Start => {
                    bootstrap::start_installed(&ssh).await?;
                }
                Step::Connect => {}
            }
            Ok(Box::new(ssh.proxy(REMOTE_AGENT)?) as Box<dyn Stream>)
        })
    })
}

/// One pass of the KTD9 rule for a connected SSH host.
async fn ssh_upgrade(ssh: &Ssh, conn: &HostConn) -> Result<Upgrade, String> {
    let (binary, build) = bootstrap::bundled()?;
    let probe = bootstrap::probe(ssh).await?;
    let same = probe.installed.as_ref().is_some_and(|i| i.sha256 == build.sha256);
    let busy = !same && agent_busy(conn).await;
    let decision = local::decide(probe.installed.as_ref(), &build, probe.running, busy);
    let done = match decision {
        Upgrade::Install => bootstrap::upload_and_install(ssh, &binary, &build).await?,
        Upgrade::Start => bootstrap::start_installed(ssh).await?,
        Upgrade::UpToDate | Upgrade::Pending | Upgrade::Blocked => return Ok(decision),
    };
    Ok(after_install(decision, done, probe.installed.as_ref(), &build, conn))
}

/// Connection errors that clear up on a retry: an agent that is still starting.
fn transient(error: &str) -> bool {
    ["preamble", "closed the connection", "isn't running", "stopped answering", "didn't say Hello"].iter().any(|t| error.contains(t))
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

/// Forwards one RPC: `method` and `params` are the agent's.
#[tauri::command]
pub async fn host_call(hosts: Hosts<'_>, host: String, method: String, params: Value) -> Result<Value, String> {
    hosts.get(&host)?.call(&method, params).await
}

/// Host events: a `host_snapshot` on every (re)connect, then upserts and status changes.
#[tauri::command]
pub async fn host_subscribe(hosts: Hosts<'_>, host: String, on_event: Channel<Value>) -> Result<u64, String> {
    Ok(hosts.get(&host)?.subscribe_host(Arc::new(move |e| {
        let _ = on_event.send(e);
    })))
}

/// A thread's events, continuous across reconnects (a `snapshot` event when the agent can't replay).
#[tauri::command]
pub async fn host_thread_subscribe(hosts: Hosts<'_>, host: String, thread_id: String, on_event: Channel<Value>) -> Result<u64, String> {
    Ok(hosts.get(&host)?.subscribe_thread(&thread_id, Arc::new(move |e| {
        let _ = on_event.send(e);
    })))
}

/// Attaches to a terminal (starting its shell if absent): raw output on `on_data`, `pty_exit` on `on_exit`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn host_pty_attach(
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
pub async fn host_unsubscribe(hosts: Hosts<'_>, host: String, sub_id: u64) -> Result<(), String> {
    hosts.get(&host)?.unsubscribe(sub_id);
    Ok(())
}

/// Concrete aliases from `~/.ssh/config` that aren't hosts yet.
#[tauri::command]
pub fn host_aliases(hosts: Hosts<'_>) -> Vec<String> {
    let added: Vec<String> = hosts.list().into_iter().map(|h| h.key).collect();
    ssh_config::aliases(&ssh_config::user_config()).into_iter().filter(|a| !added.contains(a)).collect()
}

/// Adds an SSH host and waits for its first connection. A host that turns out to be one
/// already added (another alias for the same machine, by agent host id) is merged away.
#[tauri::command]
pub async fn host_add(hosts: Hosts<'_>, alias: String) -> Result<HostInfo, String> {
    let registry = hosts.inner().clone();
    let conn = registry.add_ssh(&alias)?;
    // A just-installed agent can take a moment to listen; only a failure that retrying
    // won't fix (auth, host key, wrong OS) ends the wait early.
    let mut state = conn.watch();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let host_id = loop {
        let current = state.borrow_and_update().clone();
        match current {
            ConnState::Connected { host_id, .. } => break host_id,
            ConnState::Reconnecting { error } if !transient(&error) => return Err(error),
            _ => {}
        }
        if tokio::time::timeout_at(deadline, state.changed()).await.is_err() {
            return Err(match conn.state() {
                ConnState::Reconnecting { error } => error,
                _ => format!("{alias} didn't answer"),
            });
        }
    };
    let duplicate = registry.list().into_iter().find(|h| h.key != alias && matches!(&h.state, ConnState::Connected { host_id: id, .. } if *id == host_id));
    if let Some(same) = duplicate {
        registry.remove(&alias).await;
        return Err(format!("{alias} is the same machine as {}, which is already added", same.key));
    }
    Ok(registry.list().into_iter().find(|h| h.key == alias).expect("just added"))
}

#[tauri::command]
pub async fn host_remove(hosts: Hosts<'_>, host: String) -> Result<(), String> {
    if host == LOCAL {
        return Err("This Mac can't be removed".into());
    }
    hosts.remove(&host).await;
    Ok(())
}

/// A user-initiated reconnect, which may prompt for a passphrase.
#[tauri::command]
pub async fn host_reconnect(hosts: Hosts<'_>, host: String) -> Result<(), String> {
    hosts.reconnect(&host).await
}

#[tauri::command]
pub async fn local_agent_stop(hosts: Hosts<'_>) -> Result<(), String> {
    hosts.stop_local().await
}

#[tauri::command]
pub async fn local_agent_start(hosts: Hosts<'_>) -> Result<(), String> {
    hosts.start_local_again().await
}

/// The user's answer to an SSH prompt; `None` cancels it.
#[tauri::command]
pub fn askpass_answer(hosts: Hosts<'_>, id: u64, answer: Option<String>) {
    if let Some(askpass) = hosts.askpass() {
        askpass.answer(id, answer);
    }
}

/// The host's connection state now, then every change.
#[tauri::command]
pub async fn host_watch(hosts: Hosts<'_>, host: String, on_state: Channel<ConnState>) -> Result<(), String> {
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

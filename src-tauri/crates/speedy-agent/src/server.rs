//! U6: the agent: one [`Host`], its terminals, and every connected client (KTD2, KTD7).
//!
//! A connection opens with the agent's preamble and `Hello`, then the client's `Hello`.
//! After that the client sends RPC requests and pings. Subscriptions (the host, a thread, a
//! terminal) each get a stream id; their events and output arrive as stream frames, which
//! a slow client can lag on without slowing anything else. Clients come and go freely:
//! threads and shells belong to the agent and keep running with none connected.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use speedy_core::claude::STOP_GRACE;
use speedy_core::env::EnvService;
use speedy_core::host::log::Cursor;
use speedy_core::host::{Host, NewProject, NewThread, ThreadPatch, ThreadReplay};
use speedy_core::proto::{
    Body, Control, Event, Frame, FrameReader, Hello, MAGIC, PROTOCOL_MAX, PROTOCOL_MIN, WIRE_VERSION,
    encode, negotiate,
};
use speedy_core::pty::manager::{OutputSink, PtySpawn, login_shell};
use speedy_core::pty::{CLOSE_GRACE, PtyExit, PtyManager};
use speedy_core::state::session_index;
use speedy_core::{explorer, files, worktree};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::clients::{CLIENT_QUEUE_BYTES, Outbox, StreamError};
use crate::paths::AgentPaths;
use crate::{launchd, token};
use crate::pty_ring::{Catchup, PtyRing, RING_BYTES};

/// A client that sends nothing (not even a ping) for this long is dropped.
pub const CLIENT_SILENCE: Duration = Duration::from_secs(60);

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUILD_SHA: &str = match option_env!("SPEEDY_BUILD_SHA") {
    Some(sha) => sha,
    None => "dev",
};
/// When `scripts/build-agent.sh` built this agent (Unix seconds; 0 when unknown). Orders two
/// builds of the same version, so the app replaces an agent only with a newer one.
pub const BUILD_TIME: &str = match option_env!("SPEEDY_BUILD_TIME") {
    Some(time) => time,
    None => "0",
};

pub struct Agent {
    host: Arc<Host>,
    env: Arc<EnvService>,
    ptys: PtyManager,
    host_id: String,
    paths: AgentPaths,
    terminals: Mutex<HashMap<String, Arc<Terminal>>>,
    next_client: AtomicU64,
    shutdown: Notify,
}

/// A terminal's ring and the clients attached to it.
struct Terminal {
    ring: Mutex<PtyRing>,
    viewers: Mutex<Vec<Viewer>>,
    /// The client whose size the PTY has; size follows whoever last typed or attached (KTD7).
    sized_for: Mutex<Option<u64>>,
}

struct Viewer {
    client: u64,
    stream_id: u32,
    outbox: Outbox,
    size: (u16, u16),
}

/// One connection's subscriptions.
struct Conn {
    id: u64,
    outbox: Outbox,
    next_stream: AtomicU32,
    tasks: Mutex<HashMap<u32, JoinHandle<()>>>,
    terminals: Mutex<HashMap<u32, String>>,
}

impl Agent {
    pub fn new(host: Arc<Host>, env: Arc<EnvService>, host_id: String, paths: AgentPaths) -> Arc<Agent> {
        Arc::new_cyclic(|me: &Weak<Agent>| {
            let me = me.clone();
            let ptys = PtyManager::new(env.clone(), move |exit: PtyExit| {
                if let Some(agent) = me.upgrade() {
                    agent.on_pty_exit(exit);
                }
            });
            Agent {
                host,
                env,
                ptys,
                host_id,
                paths,
                terminals: Mutex::default(),
                next_client: AtomicU64::new(1),
                shutdown: Notify::new(),
            }
        })
    }

    pub fn hello(&self) -> Hello {
        Hello {
            protocol_min: PROTOCOL_MIN,
            protocol_max: PROTOCOL_MAX,
            agent_version: AGENT_VERSION.into(),
            build_sha: BUILD_SHA.into(),
            host_id: Some(self.host_id.clone()),
            epoch: Some(self.host.epoch()),
            capabilities: vec![],
        }
    }

    /// Resolves once a client asked the agent to stop.
    pub async fn shutdown_requested(&self) {
        self.shutdown.notified().await;
    }

    /// The desktop plan's KTD9 sequence over every thread and shell, then a final save.
    /// Blocking; call from a blocking context.
    pub fn shut_down(&self) {
        self.host.shutdown(STOP_GRACE);
        self.ptys.shutdown_all(CLOSE_GRACE);
        self.host.flush();
    }

    /// Serves one client until it disconnects or goes silent.
    pub async fn serve<S: AsyncRead + AsyncWrite + Send + 'static>(self: Arc<Self>, stream: S) {
        let (rd, mut wr) = tokio::io::split(stream);
        let (outbox, mut outgoing) = Outbox::new(CLIENT_QUEUE_BYTES);
        let hello = self.hello();
        let writer_outbox = outbox.clone();
        let writer = tokio::spawn(async move {
            let mut preamble = MAGIC.to_vec();
            preamble.extend_from_slice(&WIRE_VERSION.to_le_bytes());
            let hello = encode(&Frame { stream_id: 0, body: Body::Control(Control::Hello(hello)) }).expect("hello encodes");
            if wr.write_all(&preamble).await.is_err() || wr.write_all(&hello).await.is_err() {
                return;
            }
            while let Some(out) = outgoing.recv().await {
                if wr.write_all(&out.bytes).await.is_err() || wr.flush().await.is_err() {
                    return;
                }
                if out.counted {
                    writer_outbox.sent(out.bytes.len());
                }
            }
        });

        let conn = Arc::new(Conn {
            id: self.next_client.fetch_add(1, Ordering::SeqCst),
            outbox,
            next_stream: AtomicU32::new(1),
            tasks: Mutex::default(),
            terminals: Mutex::default(),
        });
        // However serving ends, even cancelled, the writer stops and subscriptions go.
        let _cleanup = Disconnect { agent: self.clone(), conn: conn.clone(), writer };
        let mut reader = FrameReader::new(rd);
        if let Err(e) = self.handshake(&mut reader).await {
            log::info!("client {} rejected: {e}", conn.id);
        } else {
            loop {
                let frame = match tokio::time::timeout(CLIENT_SILENCE, reader.read_frame()).await {
                    Ok(Ok(Some(frame))) => frame,
                    Ok(Ok(None)) => break,
                    Ok(Err(e)) => {
                        log::info!("client {} sent a bad frame: {e}", conn.id);
                        break;
                    }
                    Err(_) => {
                        log::info!("client {} went silent", conn.id);
                        break;
                    }
                };
                match frame.body {
                    Body::Control(Control::Ping { nonce }) => {
                        let _ = conn.outbox.send(&Frame { stream_id: 0, body: Body::Control(Control::Pong { nonce }) });
                    }
                    // `notify_one` keeps a permit, so a request between `run`'s polls isn't lost.
                    Body::Control(Control::Shutdown) => self.shutdown.notify_one(),
                    Body::Request(req) => {
                        let (agent, conn) = (self.clone(), conn.clone());
                        tokio::spawn(async move {
                            let result = agent.call(&conn, &req.method, req.params).await;
                            conn.outbox.reply(req.id, result);
                        });
                    }
                    _ => {}
                }
            }
        }
    }

    async fn handshake<R: AsyncRead + Unpin>(&self, reader: &mut FrameReader<R>) -> Result<(), String> {
        let frame = tokio::time::timeout(CLIENT_SILENCE, reader.read_frame())
            .await
            .map_err(|_| "no Hello".to_owned())?
            .map_err(|e| e.to_string())?
            .ok_or("closed before Hello")?;
        let Body::Control(Control::Hello(theirs)) = frame.body else { return Err("first frame wasn't Hello".into()) };
        negotiate(&self.hello(), &theirs).map(|_| ()).map_err(|e| e.to_string())
    }

    fn disconnect(&self, conn: &Conn) {
        for (_, task) in conn.tasks.lock().drain() {
            task.abort();
        }
        let attached: Vec<String> = conn.terminals.lock().drain().map(|(_, id)| id).collect();
        for id in attached {
            if let Some(term) = self.terminals.lock().get(&id).cloned() {
                term.viewers.lock().retain(|v| v.client != conn.id);
            }
        }
    }

    // ---- RPC ----

    async fn call(self: &Arc<Self>, conn: &Arc<Conn>, method: &str, params: Value) -> Result<Value, String> {
        fn args<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, String> {
            serde_json::from_value(params).map_err(|e| format!("bad params: {e}"))
        }
        fn ok<T: serde::Serialize>(value: T) -> Result<Value, String> {
            serde_json::to_value(value).map_err(|e| e.to_string())
        }
        let host = &self.host;
        match method {
            // Host state and subscriptions.
            "host_subscribe" => Ok(self.subscribe_host(conn)),
            "thread_subscribe" => {
                let a: ThreadSubscribe = args(params)?;
                self.subscribe_thread(conn, &a.thread_id, a.cursor)
            }
            "unsubscribe" => {
                let a: StreamArg = args(params)?;
                self.unsubscribe(conn, a.stream_id);
                Ok(Value::Null)
            }
            "project_add" => ok(host.add_project(args::<NewProject>(params)?)?),
            "project_remove" => ok(host.remove_project(&args::<IdArg>(params)?.id)?),
            "thread_create" => {
                let a: CreateThread = args(params)?;
                ok(host.create_thread(&a.project_id, a.thread)?)
            }
            "thread_update" => {
                let a: UpdateThread = args(params)?;
                ok(host.update_thread(&a.thread_id, a.patch)?)
            }
            "thread_remove" => ok(host.remove_thread(&args::<ThreadArg>(params)?.thread_id)?),
            "queue_remove" => {
                let a: QueueRemove = args(params)?;
                ok(host.remove_queued(&a.thread_id, &a.id)?)
            }

            // Threads (KTD5, KTD7).
            "claude_start" => ok(host.ensure_started(&args::<ThreadArg>(params)?.thread_id).await?),
            "claude_send_user" => {
                let a: SendUser = args(params)?;
                ok(host.send(&a.thread_id, a.content).await?)
            }
            "claude_control" => {
                let a: ControlArgs = args(params)?;
                host.actor(&a.thread_id)?.control(a.request, a.timeout_ms.map(Duration::from_millis)).await
            }
            "claude_respond_permission" => {
                let a: RespondPermission = args(params)?;
                ok(host.actor(&a.thread_id)?.respond_permission(&a.request_id, a.response).await?)
            }
            "claude_interrupt" => ok(host.actor(&args::<ThreadArg>(params)?.thread_id)?.interrupt().await?),
            "claude_stop" => {
                host.actor(&args::<ThreadArg>(params)?.thread_id)?.stop(STOP_GRACE).await;
                Ok(Value::Null)
            }
            "claude_retry" => ok(host.retry(&args::<ThreadArg>(params)?.thread_id)?),

            // Terminals.
            "pty_open" => {
                if host.draining() {
                    return Err(speedy_core::host::RESTARTING.to_owned());
                }
                let a: PtyOpen = args(params)?;
                self.open_terminal(conn, a).await
            }
            "pty_write" => {
                let a: PtyWrite = args(params)?;
                self.follow_typist(conn.id, &a.terminal_id);
                self.ptys.host.write(&a.terminal_id, a.data.as_bytes()).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "pty_resize" => {
                let a: PtyResize = args(params)?;
                self.resize_terminal(conn.id, &a.terminal_id, a.cols, a.rows)?;
                Ok(Value::Null)
            }
            "pty_close" => {
                let a: TerminalArg = args(params)?;
                self.ptys.host.close(&a.terminal_id, CLOSE_GRACE);
                Ok(Value::Null)
            }
            "pty_has_foreground_child" => ok(self.ptys.host.has_foreground_child(&args::<TerminalArg>(params)?.terminal_id)),

            // Setup.
            "agent_busy" => Ok(self.busy().into()),
            // The only way an upgrade replaces a running agent (KTD9).
            "restart_if_idle" => Ok(self.restart_if_idle().into()),
            // Where the folder browser starts (R14).
            "home_dir" => Ok(dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).into()),
            "get_setup_state" => self.setup_state().await,
            "set_claude_token" => {
                let a: TokenArg = args(params)?;
                token::set_token(&self.paths, &a.token).map_err(|e| format!("saving the token: {e}"))?;
                self.setup_state().await
            }
            "recheck_setup" => {
                let a: RecheckSetup = args(params)?;
                ok(self.env.recheck(a.override_path.map(PathBuf::from)).await)
            }
            "get_extension_settings" => ok(self.env.extension_settings()),

            // Files, git, worktrees and session history.
            "files_search" => {
                let a: FilesSearch = args(params)?;
                ok(files::files_search(a.root, a.query, a.limit, a.respect_gitignore).await?)
            }
            "explorer_list" => {
                let a: RootDir = args(params)?;
                ok(explorer::explorer_list(a.root, a.dir).await?)
            }
            "explorer_read" => {
                let a: RootPath = args(params)?;
                ok(explorer::explorer_read(a.root, a.path).await?)
            }
            "explorer_write" => {
                let a: ExplorerWrite = args(params)?;
                ok(explorer::explorer_write(a.root, a.path, a.content).await?)
            }
            "explorer_git_status" => ok(explorer::explorer_git_status(args::<RootArg>(params)?.root).await?),
            "explorer_git_branch" => ok(explorer::explorer_git_branch(args::<RootArg>(params)?.root).await?),
            "explorer_git_diff" => {
                let a: RootPath = args(params)?;
                ok(explorer::explorer_git_diff(a.root, a.path).await?)
            }
            "worktree_create" => {
                let a: WorktreeCreate = args(params)?;
                ok(worktree::worktree_create(a.root, a.branch).await?)
            }
            "worktree_unused" => {
                let a: WorktreeUnused = args(params)?;
                ok(worktree::worktree_unused(a.root, a.keep).await?)
            }
            "worktree_clean" => {
                let a: WorktreeClean = args(params)?;
                ok(worktree::worktree_clean(a.root, a.paths).await?)
            }
            "paths_exist" => ok(speedy_core::state::paths_exist(args::<PathsArg>(params)?.paths).await),
            "sessions_list" => ok(session_index::sessions_list(args::<ProjectPath>(params)?.project_path).await?),
            "session_load" => {
                let a: SessionArg = args(params)?;
                ok(session_index::session_load(a.project_path, a.session_id).await?)
            }
            "session_rename_offline" => {
                let a: SessionRename = args(params)?;
                ok(session_index::session_rename_offline(a.project_path, a.session_id, a.title).await?)
            }
            _ => Err(format!("unknown method {method}")),
        }
    }

    /// Whether replacing the agent now would interrupt work: a thread [`busy`](Host::busy), or
    /// a terminal running a command (KTD9).
    fn busy(&self) -> bool {
        self.host.busy() || self.terminal_busy()
    }

    fn terminal_busy(&self) -> bool {
        self.terminals.lock().keys().any(|id| self.ptys.host.has_foreground_child(id))
    }

    /// When nothing would be interrupted, stops taking new work and shuts the agent down so
    /// `install` can start the new build; returns whether it did. The host decides "idle" and
    /// refuses new turns under one lock (KTD9). A command typed into a terminal in the moment
    /// between the terminal check and the shutdown isn't covered; new terminals are refused.
    pub fn restart_if_idle(&self) -> bool {
        if self.terminal_busy() || !self.host.drain_if_idle() {
            return false;
        }
        log::info!("idle: restarting for an update");
        self.shutdown.notify_one();
        true
    }

    /// The core setup state, plus how the agent runs: a Background-domain agent can't read
    /// the Keychain, so the UI asks for a token there. Never includes the token itself.
    async fn setup_state(&self) -> Result<Value, String> {
        let mut state = serde_json::to_value(self.env.setup_state().await).map_err(|e| e.to_string())?;
        let domain = match launchd::current_domain() {
            launchd::Domain::Aqua => "aqua".to_owned(),
            launchd::Domain::Background => "background".to_owned(),
            launchd::Domain::Other(name) => name,
        };
        state["launchDomain"] = domain.into();
        state["tokenPresent"] = token::token_present(&self.paths).into();
        Ok(state)
    }

    fn stream_id(conn: &Conn) -> u32 {
        conn.next_stream.fetch_add(1, Ordering::SeqCst)
    }

    fn unsubscribe(&self, conn: &Conn, stream_id: u32) {
        if let Some(task) = conn.tasks.lock().remove(&stream_id) {
            task.abort();
        }
        if let Some(id) = conn.terminals.lock().remove(&stream_id)
            && let Some(term) = self.terminals.lock().get(&id).cloned()
        {
            term.viewers.lock().retain(|v| !(v.client == conn.id && v.stream_id == stream_id));
        }
    }

    /// `{streamId, snapshot}`, then host events on that stream.
    fn subscribe_host(&self, conn: &Arc<Conn>) -> Value {
        let stream_id = Self::stream_id(conn);
        let (snapshot, mut rx) = self.host.subscribe();
        let epoch = self.host.epoch();
        let outbox = conn.outbox.clone();
        let task = tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let frame = Frame { stream_id, body: Body::Event(Event { epoch, seq: 0, event: (*event).clone() }) };
                match outbox.try_stream(&frame) {
                    Ok(()) => {}
                    // Resubscribing would meet the same event, so it's dropped, not lagged.
                    Err(StreamError::Unencodable(e)) => log::warn!("host stream {stream_id}: dropped an event: {e}"),
                    Err(StreamError::Full) => {
                        // Host events are upserts: a fresh host_subscribe catches the client up.
                        outbox.lagged(stream_id, 0);
                        return;
                    }
                }
            }
        });
        conn.tasks.lock().insert(stream_id, task);
        json!({"streamId": stream_id, "snapshot": snapshot})
    }

    /// `{streamId, snapshot?}`; the replayed events (when no snapshot) and live events follow
    /// on the stream, in seq order.
    fn subscribe_thread(&self, conn: &Arc<Conn>, thread_id: &str, cursor: Option<Cursor>) -> Result<Value, String> {
        let stream_id = Self::stream_id(conn);
        let (replay, mut rx) = self.host.subscribe_thread(thread_id, cursor)?;
        let epoch = self.host.epoch();
        let (backlog, snapshot) = match replay {
            ThreadReplay::Events(events) => (events, None),
            ThreadReplay::Snapshot(snap) => (vec![], Some(snap)),
        };
        let mut last = snapshot.as_ref().map_or(cursor.map_or(0, |c| c.seq), |s| s.seq);
        let outbox = conn.outbox.clone();
        let task = tokio::spawn(async move {
            let mut backlog = backlog.into_iter();
            loop {
                let event = match backlog.next() {
                    Some(event) => event,
                    None => match rx.recv().await {
                        Some(event) => event,
                        None => return,
                    },
                };
                let seq = event["seq"].as_u64().unwrap_or(last);
                let frame = Frame { stream_id, body: Body::Event(Event { epoch, seq, event: (*event).clone() }) };
                match outbox.try_stream(&frame) {
                    Ok(()) => {}
                    // Resubscribing from `last` would replay the same event, so it's skipped.
                    Err(StreamError::Unencodable(e)) => log::warn!("thread stream {stream_id}: skipped event {seq}: {e}"),
                    Err(StreamError::Full) => {
                        outbox.lagged(stream_id, last);
                        return;
                    }
                }
                last = seq;
            }
        });
        conn.tasks.lock().insert(stream_id, task);
        Ok(json!({"streamId": stream_id, "epoch": epoch, "snapshot": snapshot}))
    }

    /// Starts the shell if absent, attaches this client, and sends what it missed after `offset`.
    async fn open_terminal(&self, conn: &Arc<Conn>, a: PtyOpen) -> Result<Value, String> {
        let stream_id = Self::stream_id(conn);
        let existing = self.terminals.lock().get(&a.terminal_id).cloned();
        let term = match existing {
            Some(term) => term,
            None => {
                let term = Arc::new(Terminal {
                    ring: Mutex::new(PtyRing::new(RING_BYTES)),
                    viewers: Mutex::default(),
                    sized_for: Mutex::new(None),
                });
                let sink_term = term.clone();
                let sink: OutputSink = Box::new(move |bytes| sink_term.output(&bytes));
                let resolved = self.env.env().await;
                let env: HashMap<String, String> =
                    if resolved.vars.is_empty() { std::env::vars().collect() } else { resolved.vars };
                let spec = PtySpawn { shell: login_shell(&env), cwd: a.cwd.clone().into(), env, cols: a.cols, rows: a.rows };
                self.ptys.host.open(&a.terminal_id, spec, sink).map_err(|e| format!("{e:#}"))?;
                self.terminals.lock().insert(a.terminal_id.clone(), term.clone());
                term
            }
        };
        {
            // Catch-up and registration under the ring lock, so no output falls in between.
            let ring = term.ring.lock();
            let body = match ring.after(a.offset) {
                Catchup::Bytes { offset, data } => Body::PtyData { offset, data },
                Catchup::Reset { offset, data } => {
                    let _ = conn.outbox.send(&Frame { stream_id, body: Body::PtyReset { offset } });
                    Body::PtyData { offset, data }
                }
            };
            // At most `RING_BYTES`, well under a frame's limit.
            let _ = conn.outbox.send(&Frame { stream_id, body });
            term.viewers.lock().push(Viewer { client: conn.id, stream_id, outbox: conn.outbox.clone(), size: (a.cols, a.rows) });
        }
        conn.terminals.lock().insert(stream_id, a.terminal_id.clone());
        self.resize_terminal(conn.id, &a.terminal_id, a.cols, a.rows)?;
        Ok(json!({"streamId": stream_id}))
    }

    /// Records this client's size and applies it: the latest attach or resize wins.
    fn resize_terminal(&self, client: u64, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let Some(term) = self.terminals.lock().get(terminal_id).cloned() else { return Err(format!("no terminal {terminal_id}")) };
        for v in term.viewers.lock().iter_mut().filter(|v| v.client == client) {
            v.size = (cols, rows);
        }
        *term.sized_for.lock() = Some(client);
        self.ptys.host.resize(terminal_id, cols, rows).map_err(|e| e.to_string())
    }

    /// Typing in a terminal sized for another client resizes it to the typist's size.
    fn follow_typist(&self, client: u64, terminal_id: &str) {
        let Some(term) = self.terminals.lock().get(terminal_id).cloned() else { return };
        if *term.sized_for.lock() == Some(client) {
            return;
        }
        let size = term.viewers.lock().iter().find(|v| v.client == client).map(|v| v.size);
        if let Some((cols, rows)) = size {
            let _ = self.resize_terminal(client, terminal_id, cols, rows);
        }
    }

    fn on_pty_exit(&self, exit: PtyExit) {
        let Some(term) = self.terminals.lock().remove(&exit.terminal_id) else { return };
        let event = json!({"kind": "pty_exit", "terminalId": exit.terminal_id, "code": exit.code});
        for v in term.viewers.lock().iter() {
            let frame = Frame { stream_id: v.stream_id, body: Body::Event(Event { epoch: self.host.epoch(), seq: 0, event: event.clone() }) };
            let _ = v.outbox.send(&frame);
        }
    }
}

struct Disconnect {
    agent: Arc<Agent>,
    conn: Arc<Conn>,
    writer: JoinHandle<()>,
}

impl Drop for Disconnect {
    fn drop(&mut self) {
        self.writer.abort();
        self.agent.disconnect(&self.conn);
    }
}

impl Terminal {
    /// Appends output to the ring and sends it to every viewer that keeps up.
    fn output(&self, data: &[u8]) {
        let mut ring = self.ring.lock();
        let offset = ring.push(data);
        self.viewers.lock().retain(|v| {
            let frame = Frame { stream_id: v.stream_id, body: Body::PtyData { offset, data: data.to_vec() } };
            match v.outbox.try_stream(&frame) {
                Ok(()) => return true,
                Err(StreamError::Unencodable(e)) => {
                    log::warn!("terminal stream {}: dropped output: {e}", v.stream_id);
                    return true;
                }
                Err(StreamError::Full) => {}
            }
            // The client reattaches from its last offset (KTD7).
            v.outbox.lagged(v.stream_id, offset);
            false
        });
    }
}

/// Only the agent's own user may connect (KTD12). SSH has already authenticated a proxied client.
pub fn peer_allowed(peer_uid: u32) -> bool {
    peer_uid == unsafe { libc::geteuid() }
}

#[derive(Deserialize)]
struct TokenArg {
    token: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadArg {
    thread_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArg {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamArg {
    stream_id: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSubscribe {
    thread_id: String,
    cursor: Option<Cursor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateThread {
    project_id: String,
    thread: NewThread,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateThread {
    thread_id: String,
    patch: ThreadPatch,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueRemove {
    thread_id: String,
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendUser {
    thread_id: String,
    content: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlArgs {
    thread_id: String,
    request: Value,
    timeout_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondPermission {
    thread_id: String,
    request_id: String,
    response: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalArg {
    terminal_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyOpen {
    terminal_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    /// The client has everything before this output offset; absent for a new view.
    offset: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyWrite {
    terminal_id: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyResize {
    terminal_id: String,
    cols: u16,
    rows: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecheckSetup {
    override_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesSearch {
    root: String,
    query: String,
    limit: Option<usize>,
    respect_gitignore: Option<bool>,
}
#[derive(Deserialize)]
struct RootArg {
    root: String,
}
#[derive(Deserialize)]
struct RootDir {
    root: String,
    dir: String,
}
#[derive(Deserialize)]
struct RootPath {
    root: String,
    path: String,
}
#[derive(Deserialize)]
struct ExplorerWrite {
    root: String,
    path: String,
    content: String,
}
#[derive(Deserialize)]
struct WorktreeCreate {
    root: String,
    branch: String,
}
#[derive(Deserialize)]
struct WorktreeUnused {
    root: String,
    keep: Vec<String>,
}
#[derive(Deserialize)]
struct WorktreeClean {
    root: String,
    paths: Vec<String>,
}
#[derive(Deserialize)]
struct PathsArg {
    paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPath {
    project_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionArg {
    project_path: String,
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRename {
    project_path: String,
    session_id: String,
    title: String,
}

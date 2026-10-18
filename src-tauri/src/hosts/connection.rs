//! U8: one host's connection, kept alive across drops (KTD14).
//!
//! A [`HostConn`] owns one connect → handshake → resubscribe → serve loop. Subscriptions
//! outlive connections: each remembers its cursor (a thread's last `(epoch, seq)`, a
//! terminal's last byte offset), and after a reconnect it is resubscribed from there, so its
//! sink sees one continuous stream. A ping goes out every [`PING_EVERY`]; silence for
//! [`DEAD_AFTER`] drops the connection and the loop reconnects with backoff.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use speedy_core::proto::{Body, Control, Frame, FrameReader, Hello, PROTOCOL_MAX, PROTOCOL_MIN, Request, encode, negotiate};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, oneshot, watch};

pub const PING_EVERY: Duration = Duration::from_secs(5);
pub const DEAD_AFTER: Duration = Duration::from_secs(25);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// ANSI "reset to initial state": a terminal that was further behind than the agent's ring
/// starts over from the ring (KTD5).
const TERMINAL_RESET: &[u8] = b"\x1bc";

pub trait Stream: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> Stream for T {}

/// Opens a fresh byte stream to the host's agent.
pub type Connector = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Box<dyn Stream>, String>> + Send>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConnState {
    Connecting,
    Connected { host_id: String, agent_version: String },
    Reconnecting { error: String },
}

pub type JsonSink = Arc<dyn Fn(Value) + Send + Sync>;
pub type BytesSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// A cursor into a thread's events (KTD5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Cursor {
    pub epoch: u64,
    pub seq: u64,
}

enum Kind {
    Host,
    Thread { thread_id: String, cursor: Option<Cursor> },
    Pty { terminal_id: String, cwd: String, cols: u16, rows: u16, offset: Option<u64> },
}

struct Sub {
    kind: Kind,
    json: Option<JsonSink>,
    bytes: Option<BytesSink>,
    /// The agent's stream id on the current connection.
    stream_id: Option<u32>,
}

/// RPCs awaiting their response, by request id.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// The current connection, while there is one.
struct Live {
    out: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
    hello: Hello,
    /// Stream frames that arrived before the subscribe reply naming their stream; the agent
    /// may send a replay's first events (or a terminal's catch-up) ahead of it.
    early: Mutex<HashMap<u32, Vec<Frame>>>,
}

pub struct HostConn {
    me: Weak<HostConn>,
    connector: Connector,
    state: watch::Sender<ConnState>,
    live: Mutex<Option<Arc<Live>>>,
    subs: Mutex<HashMap<u64, Sub>>,
    next_sub: AtomicU64,
    next_request: AtomicU64,
    /// Wakes the loop to drop the current connection and reconnect at once (wake from sleep).
    reconnect: Notify,
}

impl HostConn {
    /// Starts connecting in the background. Must be called inside a tokio runtime.
    pub fn start(connector: Connector) -> Arc<HostConn> {
        let conn = Arc::new_cyclic(|me| HostConn {
            me: me.clone(),
            connector,
            state: watch::channel(ConnState::Connecting).0,
            live: Mutex::default(),
            subs: Mutex::default(),
            next_sub: AtomicU64::new(1),
            next_request: AtomicU64::new(1),
            reconnect: Notify::new(),
        });
        let run = conn.clone();
        tokio::spawn(async move { run.run().await });
        conn
    }

    pub fn state(&self) -> ConnState {
        self.state.borrow().clone()
    }

    pub fn watch(&self) -> watch::Receiver<ConnState> {
        self.state.subscribe()
    }

    /// Drops the current connection and reconnects now, resubscribing from stored cursors.
    pub fn reconnect_now(&self) {
        self.reconnect.notify_waiters();
    }

    /// An RPC on the current connection; fails at once when the host isn't connected.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let live = self.live.lock().clone().ok_or("the host isn't connected")?;
        Self::request(&live, &self.next_request, method, params).await
    }

    async fn request(live: &Live, ids: &AtomicU64, method: &str, params: Value) -> Result<Value, String> {
        let id = ids.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        live.pending.lock().insert(id, tx);
        let frame = Frame { stream_id: 0, body: Body::Request(Request { id, method: method.into(), params }) };
        live.out.send(encode(&frame).map_err(|e| e.to_string())?).map_err(|_| "the host disconnected")?;
        rx.await.map_err(|_| "the host disconnected".to_owned())?
    }

    /// Host events, starting with `{"kind":"host_snapshot", "snapshot": …}` on every (re)connect.
    pub fn subscribe_host(&self, sink: JsonSink) -> u64 {
        self.add(Sub { kind: Kind::Host, json: Some(sink), bytes: None, stream_id: None })
    }

    /// A thread's events. After a reconnect the sink sees only events it missed; when the agent
    /// can't replay them it gets `{"kind":"snapshot", "snapshot": …}` to reseed from instead.
    pub fn subscribe_thread(&self, thread_id: &str, sink: JsonSink) -> u64 {
        self.add(Sub { kind: Kind::Thread { thread_id: thread_id.into(), cursor: None }, json: Some(sink), bytes: None, stream_id: None })
    }

    /// A terminal's output (and `{"kind":"pty_exit"}` on `exit`), opening its shell if absent.
    pub fn attach_terminal(&self, terminal_id: &str, cwd: &str, cols: u16, rows: u16, output: BytesSink, exit: JsonSink) -> u64 {
        let kind = Kind::Pty { terminal_id: terminal_id.into(), cwd: cwd.into(), cols, rows, offset: None };
        self.add(Sub { kind, json: Some(exit), bytes: Some(output), stream_id: None })
    }

    /// Records a terminal's new size, so a resubscribe reattaches at that size.
    pub fn note_terminal_size(&self, terminal_id: &str, new_cols: u16, new_rows: u16) {
        for sub in self.subs.lock().values_mut() {
            if let Kind::Pty { terminal_id: id, cols, rows, .. } = &mut sub.kind
                && id == terminal_id
            {
                (*cols, *rows) = (new_cols, new_rows);
            }
        }
    }

    pub fn unsubscribe(&self, sub_id: u64) {
        let Some(sub) = self.subs.lock().remove(&sub_id) else { return };
        if let (Some(stream_id), Some(live)) = (sub.stream_id, self.live.lock().clone()) {
            let ids = self.me.upgrade();
            tokio::spawn(async move {
                if let Some(conn) = ids {
                    let _ = Self::request(&live, &conn.next_request, "unsubscribe", json!({"streamId": stream_id})).await;
                }
            });
        }
    }

    fn add(&self, sub: Sub) -> u64 {
        let id = self.next_sub.fetch_add(1, Ordering::SeqCst);
        self.subs.lock().insert(id, sub);
        if let (Some(live), Some(conn)) = (self.live.lock().clone(), self.me.upgrade()) {
            tokio::spawn(async move { conn.open(&live, id).await });
        }
        id
    }

    // ---- the connection loop ----

    async fn run(self: Arc<Self>) {
        let mut backoff = Duration::from_millis(250);
        loop {
            match self.serve_once().await {
                Ok(()) => backoff = Duration::from_millis(250),
                Err(error) => {
                    self.state.send_replace(ConnState::Reconnecting { error });
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = self.reconnect.notified() => {}
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                }
            }
            if self.me.strong_count() <= 1 {
                return;
            }
        }
    }

    /// One connection, from connect until it drops. `Ok` means a deliberate reconnect.
    async fn serve_once(self: &Arc<Self>) -> Result<(), String> {
        let stream = (self.connector)().await?;
        let (rd, mut wr) = tokio::io::split(stream);
        let mut reader = FrameReader::new(rd);
        reader.read_preamble().await.map_err(|e| format!("no agent preamble: {e}"))?;
        let theirs = match reader.read_frame().await.map_err(|e| e.to_string())? {
            Some(Frame { body: Body::Control(Control::Hello(h)), .. }) => h,
            _ => return Err("the agent didn't say Hello".into()),
        };
        let ours = client_hello();
        negotiate(&ours, &theirs).map_err(|e| e.to_string())?;
        wr.write_all(&encode(&Frame { stream_id: 0, body: Body::Control(Control::Hello(ours)) }).map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())?;

        let (out, mut outgoing) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let writer = tokio::spawn(async move {
            while let Some(bytes) = outgoing.recv().await {
                if wr.write_all(&bytes).await.is_err() || wr.flush().await.is_err() {
                    return;
                }
            }
        });
        let live = Arc::new(Live { out, pending: Arc::default(), hello: theirs.clone(), early: Mutex::default() });
        *self.live.lock() = Some(live.clone());
        self.state.send_replace(ConnState::Connected {
            host_id: theirs.host_id.clone().unwrap_or_default(),
            agent_version: theirs.agent_version.clone(),
        });
        let ids: Vec<u64> = self.subs.lock().keys().copied().collect();
        for id in ids {
            let (conn, live) = (self.clone(), live.clone());
            tokio::spawn(async move { conn.open(&live, id).await });
        }

        let mut ping = tokio::time::interval(PING_EVERY);
        let result = loop {
            tokio::select! {
                frame = tokio::time::timeout(DEAD_AFTER, reader.read_frame()) => match frame {
                    Ok(Ok(Some(frame))) => self.route(&live, frame),
                    Ok(Ok(None)) => break Err("the agent closed the connection".to_owned()),
                    Ok(Err(e)) => break Err(e.to_string()),
                    Err(_) => break Err("the agent stopped answering".to_owned()),
                },
                _ = ping.tick() => {
                    let frame = Frame { stream_id: 0, body: Body::Control(Control::Ping { nonce: 0 }) };
                    let _ = live.out.send(encode(&frame).expect("ping encodes"));
                }
                _ = self.reconnect.notified() => break Ok(()),
            }
        };
        writer.abort();
        *self.live.lock() = None;
        for sub in self.subs.lock().values_mut() {
            sub.stream_id = None;
        }
        // Calls in flight on this connection fail now rather than hanging.
        live.pending.lock().clear();
        if result.is_ok() {
            self.state.send_replace(ConnState::Connecting);
        }
        result
    }

    /// (Re)subscribes `id` on `live`, from its stored cursor.
    async fn open(self: &Arc<Self>, live: &Live, id: u64) {
        let (method, params) = {
            let subs = self.subs.lock();
            let Some(sub) = subs.get(&id) else { return };
            match &sub.kind {
                Kind::Host => ("host_subscribe", json!({})),
                Kind::Thread { thread_id, cursor } => ("thread_subscribe", json!({"threadId": thread_id, "cursor": cursor})),
                Kind::Pty { terminal_id, cwd, cols, rows, offset } => {
                    ("pty_open", json!({"terminalId": terminal_id, "cwd": cwd, "cols": cols, "rows": rows, "offset": offset}))
                }
            }
        };
        let reply = match Self::request(live, &self.next_request, method, params).await {
            Ok(reply) => reply,
            Err(error) => {
                let sink = self.subs.lock().get(&id).and_then(|s| s.json.clone());
                if let Some(sink) = sink {
                    sink(json!({"kind": "subscribe_failed", "error": error}));
                }
                return;
            }
        };
        let Some(stream_id) = reply["streamId"].as_u64().map(|s| s as u32) else { return };
        let mut subs = self.subs.lock();
        let Some(sub) = subs.get_mut(&id) else {
            drop(subs);
            let (conn, live_out) = (self.clone(), live.out.clone());
            // Unsubscribed while the subscribe was in flight.
            let frame = Frame { stream_id: 0, body: Body::Request(Request { id: conn.next_request.fetch_add(1, Ordering::SeqCst), method: "unsubscribe".into(), params: json!({"streamId": stream_id}) }) };
            let _ = live_out.send(encode(&frame).expect("encodes"));
            return;
        };
        sub.stream_id = Some(stream_id);
        match &mut sub.kind {
            Kind::Host => {
                if let Some(sink) = &sub.json {
                    sink(json!({"kind": "host_snapshot", "snapshot": reply["snapshot"]}));
                }
            }
            Kind::Thread { cursor, .. } => {
                if !reply["snapshot"].is_null() {
                    let snap = &reply["snapshot"];
                    *cursor = Some(Cursor { epoch: snap["epoch"].as_u64().unwrap_or(0), seq: snap["seq"].as_u64().unwrap_or(0) });
                    if let Some(sink) = &sub.json {
                        sink(json!({"kind": "snapshot", "snapshot": snap}));
                    }
                }
            }
            Kind::Pty { .. } => {}
        }
        drop(subs);
        let early = live.early.lock().remove(&stream_id).unwrap_or_default();
        for frame in early {
            self.route(live, frame);
        }
    }

    fn route(&self, live: &Live, frame: Frame) {
        let stream_frame = matches!(frame.body, Body::Event(_) | Body::PtyData { .. } | Body::PtyReset { .. });
        if stream_frame && !self.subs.lock().values().any(|s| s.stream_id == Some(frame.stream_id)) {
            live.early.lock().entry(frame.stream_id).or_default().push(frame);
            return;
        }
        match frame.body {
            Body::Response(r) => {
                if let Some(tx) = live.pending.lock().remove(&r.id) {
                    let _ = tx.send(r.result);
                }
            }
            Body::Event(event) => {
                let mut subs = self.subs.lock();
                let Some(sub) = subs.values_mut().find(|s| s.stream_id == Some(frame.stream_id)) else { return };
                if let Kind::Thread { cursor, .. } = &mut sub.kind {
                    // A replay can overlap events already delivered; each is delivered once.
                    if cursor.is_some_and(|c| c.epoch == event.epoch && event.seq <= c.seq) {
                        return;
                    }
                    *cursor = Some(Cursor { epoch: event.epoch, seq: event.seq });
                }
                if let Some(sink) = sub.json.clone() {
                    drop(subs);
                    sink(event.event);
                }
            }
            Body::PtyData { offset, data } => {
                let mut subs = self.subs.lock();
                let Some(sub) = subs.values_mut().find(|s| s.stream_id == Some(frame.stream_id)) else { return };
                let Kind::Pty { offset: seen, .. } = &mut sub.kind else { return };
                let end = offset + data.len() as u64;
                // Skip bytes already delivered on an earlier connection.
                let skip = seen.map_or(0, |s| s.saturating_sub(offset)) as usize;
                if skip >= data.len() {
                    return;
                }
                *seen = Some(end);
                if let Some(sink) = sub.bytes.clone() {
                    drop(subs);
                    sink(data[skip..].to_vec());
                }
            }
            Body::PtyReset { offset } => {
                let mut subs = self.subs.lock();
                let Some(sub) = subs.values_mut().find(|s| s.stream_id == Some(frame.stream_id)) else { return };
                let Kind::Pty { offset: seen, .. } = &mut sub.kind else { return };
                let fresh = seen.is_none();
                *seen = Some(offset);
                if let (false, Some(sink)) = (fresh, sub.bytes.clone()) {
                    drop(subs);
                    sink(TERMINAL_RESET.to_vec());
                }
            }
            Body::Control(Control::Lagged { stream_id, .. }) => {
                let id = self.subs.lock().iter().find(|(_, s)| s.stream_id == Some(stream_id)).map(|(id, _)| *id);
                if let (Some(id), Some(conn)) = (id, self.me.upgrade()) {
                    let live = self.live.lock().clone();
                    if let Some(live) = live {
                        tokio::spawn(async move { conn.open(&live, id).await });
                    }
                }
            }
            _ => {}
        }
    }

    /// The agent's Hello on the current connection.
    pub fn agent_hello(&self) -> Option<Hello> {
        self.live.lock().as_ref().map(|l| l.hello.clone())
    }
}

pub fn client_hello() -> Hello {
    Hello {
        protocol_min: PROTOCOL_MIN,
        protocol_max: PROTOCOL_MAX,
        agent_version: env!("CARGO_PKG_VERSION").into(),
        build_sha: option_env!("SPEEDY_BUILD_SHA").unwrap_or("dev").into(),
        host_id: None,
        epoch: None,
        capabilities: vec![],
    }
}

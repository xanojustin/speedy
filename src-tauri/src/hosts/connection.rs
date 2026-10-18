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
use speedy_core::host::log::Cursor;
use speedy_core::proto::{Body, Control, Frame, FrameReader, Hello, PROTOCOL_MAX, PROTOCOL_MIN, Request, encode, negotiate};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, oneshot, watch};

pub const PING_EVERY: Duration = Duration::from_secs(5);
pub const DEAD_AFTER: Duration = Duration::from_secs(25);
/// How long a connected stream may take to send its preamble and Hello. The connector itself
/// (an SSH master that may wait on a passphrase prompt) is not timed.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A connection that stayed up this long resets the reconnect backoff.
const HEALTHY_AFTER: Duration = Duration::from_secs(5);
/// Most stream-frame bytes held for subscribes in flight, per connection.
const EARLY_MAX_BYTES: usize = 8 << 20;
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
    early: Mutex<Early>,
}

/// Stream frames that arrived before the subscribe reply naming their stream; the agent may
/// send a replay's first events (or a terminal's catch-up) ahead of it. Frames are held only
/// while some subscribe is in flight; others belong to no one and are dropped. Lock order:
/// `HostConn::subs`, then this.
#[derive(Default)]
struct Early {
    frames: HashMap<u32, Vec<Frame>>,
    bytes: usize,
    /// Subscribes awaiting their reply.
    opening: usize,
}

impl Early {
    fn hold(&mut self, frame: Frame) {
        let size = frame_size(&frame);
        if self.bytes + size > EARLY_MAX_BYTES {
            log::warn!("dropping a frame for stream {}: too much buffered for subscribes in flight", frame.stream_id);
            return;
        }
        self.bytes += size;
        self.frames.entry(frame.stream_id).or_default().push(frame);
    }

    fn take(&mut self, stream_id: u32) -> Vec<Frame> {
        let frames = self.frames.remove(&stream_id).unwrap_or_default();
        self.bytes = self.bytes.saturating_sub(frames.iter().map(frame_size).sum());
        frames
    }

    /// A subscribe got its reply (or failed); with none left in flight nothing is waited for.
    fn opened(&mut self) {
        self.opening = self.opening.saturating_sub(1);
        if self.opening == 0 {
            self.frames.clear();
            self.bytes = 0;
        }
    }
}

fn frame_size(frame: &Frame) -> usize {
    match &frame.body {
        Body::PtyData { data, .. } => data.len(),
        Body::Event(event) => event.event.to_string().len(),
        _ => 16,
    }
}

/// A sink call, made after the lock that chose it is released.
enum Delivery {
    Json(JsonSink, Value),
    Bytes(BytesSink, Vec<u8>),
}

impl Delivery {
    fn send(self) {
        match self {
            Delivery::Json(sink, value) => sink(value),
            Delivery::Bytes(sink, bytes) => sink(bytes),
        }
    }
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
    /// Set once by [`HostConn::close`]; the loop stops for good.
    closed: watch::Sender<bool>,
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
            closed: watch::channel(false).0,
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

    /// Drops the current connection (or abandons a connect in progress) and reconnects now,
    /// resubscribing from stored cursors. Not lost when the loop isn't waiting at that moment.
    pub fn reconnect_now(&self) {
        self.reconnect.notify_one();
    }

    /// Stops the connection for good: no more reconnects (or connector calls).
    pub fn close(&self) {
        self.closed.send_replace(true);
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Resolves once [`HostConn::close`] is called.
    pub async fn closed(&self) {
        let mut closed = self.closed.subscribe();
        let _ = closed.wait_for(|c| *c).await;
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
            live.early.lock().take(stream_id);
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
        let mut backoff = BACKOFF_MIN;
        loop {
            if self.is_closed() {
                return;
            }
            let (result, healthy) = self.serve_once().await;
            if self.is_closed() {
                return;
            }
            if healthy {
                backoff = BACKOFF_MIN;
            }
            match result {
                Ok(()) => backoff = BACKOFF_MIN,
                Err(error) => {
                    self.state.send_replace(ConnState::Reconnecting { error });
                    tokio::select! {
                        _ = tokio::time::sleep(backoff + jitter(backoff)) => {}
                        _ = self.reconnect.notified() => {}
                        _ = self.closed() => return,
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                }
            }
            if self.me.strong_count() <= 1 {
                return;
            }
        }
    }

    /// Connects and reads the agent's preamble and Hello. The handshake is timed; the
    /// connector is not (it may wait on the user).
    async fn handshake(&self) -> Result<(FrameReader<tokio::io::ReadHalf<Box<dyn Stream>>>, tokio::io::WriteHalf<Box<dyn Stream>>, Hello), String> {
        let stream = (self.connector)().await?;
        let (rd, mut wr) = tokio::io::split(stream);
        let mut reader = FrameReader::new(rd);
        let theirs = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            reader.read_preamble().await.map_err(|e| format!("no agent preamble: {e}"))?;
            let theirs = match reader.read_frame().await.map_err(|e| e.to_string())? {
                Some(Frame { body: Body::Control(Control::Hello(h)), .. }) => h,
                _ => return Err("the agent didn't say Hello".to_owned()),
            };
            let ours = client_hello();
            negotiate(&ours, &theirs).map_err(|e| e.to_string())?;
            wr.write_all(&encode(&Frame { stream_id: 0, body: Body::Control(Control::Hello(ours)) }).map_err(|e| e.to_string())?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(theirs)
        })
        .await
        .map_err(|_| format!("no agent preamble or Hello within {}s", HANDSHAKE_TIMEOUT.as_secs()))??;
        Ok((reader, wr, theirs))
    }

    /// One connection, from connect until it drops. `Ok` means a deliberate reconnect (or a
    /// close); the flag says whether the connection was up long enough to count as healthy.
    async fn serve_once(self: &Arc<Self>) -> (Result<(), String>, bool) {
        let handshake = tokio::select! {
            r = self.handshake() => r,
            _ = self.reconnect.notified() => return (Ok(()), false),
            _ = self.closed() => return (Ok(()), false),
        };
        let (mut reader, mut wr, theirs) = match handshake {
            Ok(parts) => parts,
            Err(e) => return (Err(e), false),
        };
        let connected_at = tokio::time::Instant::now();

        let (out, mut outgoing) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let writer = tokio::spawn(async move {
            while let Some(bytes) = outgoing.recv().await {
                if wr.write_all(&bytes).await.is_err() || wr.flush().await.is_err() {
                    return;
                }
            }
        });
        let live = Arc::new(Live { out, pending: Arc::default(), early: Mutex::default() });
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
        // Silence is measured from the last frame: a timeout around the read would restart
        // with every ping tick and never fire. `read_frame` is cancel-safe.
        let mut last_heard = tokio::time::Instant::now();
        let result = loop {
            tokio::select! {
                frame = reader.read_frame() => match frame {
                    Ok(Some(frame)) => {
                        last_heard = tokio::time::Instant::now();
                        self.route(&live, frame);
                    }
                    Ok(None) => break Err("the agent closed the connection".to_owned()),
                    Err(e) => break Err(e.to_string()),
                },
                _ = ping.tick() => {
                    if last_heard.elapsed() > DEAD_AFTER {
                        break Err("the agent stopped answering".to_owned());
                    }
                    let frame = Frame { stream_id: 0, body: Body::Control(Control::Ping { nonce: 0 }) };
                    let _ = live.out.send(encode(&frame).expect("ping encodes"));
                }
                _ = self.reconnect.notified() => break Ok(()),
                _ = self.closed() => break Ok(()),
            }
        };
        writer.abort();
        *self.live.lock() = None;
        for sub in self.subs.lock().values_mut() {
            sub.stream_id = None;
        }
        // Calls in flight on this connection fail now rather than hanging.
        live.pending.lock().clear();
        if result.is_ok() && !self.is_closed() {
            self.state.send_replace(ConnState::Connecting);
        }
        (result, connected_at.elapsed() >= HEALTHY_AFTER)
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
        // Until the reply names the stream, its frames are held (see [`Early`]).
        live.early.lock().opening += 1;
        let reply = match Self::request(live, &self.next_request, method, params).await {
            Ok(reply) => reply,
            Err(error) => {
                live.early.lock().opened();
                let sink = self.subs.lock().get(&id).and_then(|s| s.json.clone());
                if let Some(sink) = sink {
                    sink(json!({"kind": "subscribe_failed", "error": error}));
                }
                return;
            }
        };
        let Some(stream_id) = reply["streamId"].as_u64().map(|s| s as u32) else {
            live.early.lock().opened();
            return;
        };
        // Taking the held frames and claiming the stream happen under the `subs` lock that
        // `route` checks ownership under, and the held frames are delivered before it's
        // released: no frame is stranded, and none overtakes an older one.
        let mut subs = self.subs.lock();
        let early = {
            let mut early = live.early.lock();
            let frames = early.take(stream_id);
            early.opened();
            frames
        };
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
        for frame in early {
            if let Some(delivery) = deliver(&mut subs, frame) {
                delivery.send();
            }
        }
    }

    fn route(&self, live: &Live, frame: Frame) {
        match frame.body {
            Body::Response(r) => {
                if let Some(tx) = live.pending.lock().remove(&r.id) {
                    let _ = tx.send(r.result);
                }
            }
            Body::Event(_) | Body::PtyData { .. } | Body::PtyReset { .. } => {
                let mut subs = self.subs.lock();
                if sub_for_stream(&mut subs, frame.stream_id).is_none() {
                    let mut early = live.early.lock();
                    if early.opening > 0 {
                        early.hold(frame);
                    }
                    return;
                }
                let delivery = deliver(&mut subs, frame);
                drop(subs);
                if let Some(delivery) = delivery {
                    delivery.send();
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
}

/// Advances the owning subscription's cursor for a stream frame and says what its sink gets.
fn deliver(subs: &mut HashMap<u64, Sub>, frame: Frame) -> Option<Delivery> {
    let sub = sub_for_stream(subs, frame.stream_id)?;
    match frame.body {
        Body::Event(event) => {
            if let Kind::Thread { cursor, .. } = &mut sub.kind {
                // A replay can overlap events already delivered; each is delivered once.
                if cursor.is_some_and(|c| c.epoch == event.epoch && event.seq <= c.seq) {
                    return None;
                }
                *cursor = Some(Cursor { epoch: event.epoch, seq: event.seq });
            }
            Some(Delivery::Json(sub.json.clone()?, event.event))
        }
        Body::PtyData { offset, data } => {
            let Kind::Pty { offset: seen, .. } = &mut sub.kind else { return None };
            let end = offset + data.len() as u64;
            // Skip bytes already delivered on an earlier connection.
            let skip = seen.map_or(0, |s| s.saturating_sub(offset)) as usize;
            if skip >= data.len() {
                return None;
            }
            *seen = Some(end);
            Some(Delivery::Bytes(sub.bytes.clone()?, if skip == 0 { data } else { data[skip..].to_vec() }))
        }
        Body::PtyReset { offset } => {
            let Kind::Pty { offset: seen, .. } = &mut sub.kind else { return None };
            let fresh = seen.is_none();
            *seen = Some(offset);
            if fresh { None } else { Some(Delivery::Bytes(sub.bytes.clone()?, TERMINAL_RESET.to_vec())) }
        }
        _ => None,
    }
}

/// Up to a tenth of `backoff`, so hosts that dropped together don't reconnect in lockstep.
fn jitter(backoff: Duration) -> Duration {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let tenth = backoff.as_millis() as u64 / 10;
    Duration::from_millis(if tenth == 0 { 0 } else { u64::from(nanos) % tenth })
}

/// The subscription that `stream_id` belongs to on the current connection.
fn sub_for_stream(subs: &mut HashMap<u64, Sub>, stream_id: u32) -> Option<&mut Sub> {
    subs.values_mut().find(|s| s.stream_id == Some(stream_id))
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

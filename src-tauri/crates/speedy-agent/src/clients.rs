//! U6: one connected client's outbound queue (KTD7).
//!
//! Every frame for a client goes through its [`Outbox`] to one writer task. Stream frames
//! (thread events, terminal output) count against a byte budget; a stream that would push
//! the client past it is cut off with `Lagged`, and the client catches up by resubscribing
//! from its cursor. Replies and control frames always go through. Nothing here ever blocks
//! the `claude` or PTY readers.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;
use speedy_core::proto::{Body, Control, Frame, ProtoError, Response, encode};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Stream bytes a client may have queued before a stream is cut off as lagged.
pub const CLIENT_QUEUE_BYTES: usize = 8 << 20;

/// An encoded frame for the writer, and whether it counts against the stream budget.
pub struct Outgoing {
    pub bytes: Vec<u8>,
    pub counted: bool,
}

#[derive(Clone)]
pub struct Outbox {
    tx: UnboundedSender<Outgoing>,
    queued: Arc<AtomicUsize>,
    cap: usize,
}

/// Why [`Outbox::try_stream`] didn't queue a frame.
#[derive(Debug)]
pub enum StreamError {
    /// The frame didn't fit in the client's budget (or the client is gone); the stream must
    /// be cut off with `Lagged`.
    Full,
    /// The frame can never be sent (over `MAX_FRAME_LEN`). Resubscribing would hit it again,
    /// so the caller skips it instead of cutting the stream off.
    Unencodable(ProtoError),
}

impl Outbox {
    /// The outbox and the receiver its writer task drains with [`Outbox::sent`].
    pub fn new(cap: usize) -> (Outbox, UnboundedReceiver<Outgoing>) {
        let (tx, rx) = unbounded_channel();
        (Outbox { tx, queued: Arc::default(), cap }, rx)
    }

    /// Replies and control frames, outside the budget.
    pub fn send(&self, frame: &Frame) -> Result<(), ProtoError> {
        let bytes = encode(frame)?;
        let _ = self.tx.send(Outgoing { bytes, counted: false });
        Ok(())
    }

    /// The reply to request `id`. A result too large for one frame becomes an error reply,
    /// so the caller fails instead of waiting forever.
    pub fn reply(&self, id: u64, result: Result<Value, String>) {
        let Err(e) = self.send(&Frame { stream_id: 0, body: Body::Response(Response { id, result }) }) else { return };
        let message = match e {
            ProtoError::FrameTooLarge(len) => format!("reply too large ({len} bytes)"),
            other => format!("reply couldn't be encoded: {other}"),
        };
        log::warn!("request {id}: {message}");
        let fallback = Frame { stream_id: 0, body: Body::Response(Response { id, result: Err(message) }) };
        if let Err(e) = self.send(&fallback) {
            log::warn!("request {id}: the error reply failed too: {e}");
        }
    }

    /// A stream frame, refused when it would exceed the budget or can't be encoded.
    pub fn try_stream(&self, frame: &Frame) -> Result<(), StreamError> {
        let bytes = encode(frame).map_err(StreamError::Unencodable)?;
        let len = bytes.len();
        if self.queued.fetch_add(len, Ordering::SeqCst) + len > self.cap {
            self.queued.fetch_sub(len, Ordering::SeqCst);
            return Err(StreamError::Full);
        }
        self.tx.send(Outgoing { bytes, counted: true }).map_err(|_| StreamError::Full)
    }

    /// Cuts off `stream_id`, telling the client where it got to.
    pub fn lagged(&self, stream_id: u32, last_sent_seq: u64) {
        let _ = self.send(&Frame { stream_id: 0, body: Body::Control(Control::Lagged { stream_id, last_sent_seq }) });
    }

    /// Called by the writer task after writing a counted frame of `len` bytes.
    pub fn sent(&self, len: usize) {
        self.queued.fetch_sub(len, Ordering::SeqCst);
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

//! U6: one connected client's outbound queue (KTD7).
//!
//! Every frame for a client goes through its [`Outbox`] to one writer task. Stream frames
//! (thread events, terminal output) count against a byte budget; a stream that would push
//! the client past it is cut off with `Lagged`, and the client catches up by resubscribing
//! from its cursor. Replies and control frames always go through. Nothing here ever blocks
//! the `claude` or PTY readers.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use speedy_core::proto::{Body, Control, Frame, encode};
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

/// The stream frame didn't fit in the client's budget; the stream must be cut off.
#[derive(Debug)]
pub struct Full;

impl Outbox {
    /// The outbox and the receiver its writer task drains with [`Outbox::sent`].
    pub fn new(cap: usize) -> (Outbox, UnboundedReceiver<Outgoing>) {
        let (tx, rx) = unbounded_channel();
        (Outbox { tx, queued: Arc::default(), cap }, rx)
    }

    /// Replies and control frames, outside the budget.
    pub fn send(&self, frame: &Frame) {
        if let Ok(bytes) = encode(frame) {
            let _ = self.tx.send(Outgoing { bytes, counted: false });
        }
    }

    /// A stream frame, refused when it would exceed the budget.
    pub fn try_stream(&self, frame: &Frame) -> Result<(), Full> {
        let bytes = encode(frame).map_err(|_| Full)?;
        let len = bytes.len();
        if self.queued.fetch_add(len, Ordering::SeqCst) + len > self.cap {
            self.queued.fetch_sub(len, Ordering::SeqCst);
            return Err(Full);
        }
        self.tx.send(Outgoing { bytes, counted: true }).map_err(|_| Full)
    }

    /// Cuts off `stream_id`, telling the client where it got to.
    pub fn lagged(&self, stream_id: u32, last_sent_seq: u64) {
        self.send(&Frame { stream_id: 0, body: Body::Control(Control::Lagged { stream_id, last_sent_seq }) });
    }

    /// Called by the writer task after writing a counted frame of `len` bytes.
    pub fn sent(&self, len: usize) {
        self.queued.fetch_sub(len, Ordering::SeqCst);
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

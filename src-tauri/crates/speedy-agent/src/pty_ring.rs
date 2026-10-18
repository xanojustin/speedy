//! U6: each terminal's recent output, addressed by byte offset, so a client that reattaches
//! gets exactly what it missed (KTD5). TUIs redraw on resize, so a reset plus the ring's
//! contents is enough when the client is further behind than the ring reaches.

use std::collections::VecDeque;

/// Each terminal keeps this much recent output.
pub const RING_BYTES: usize = 2 << 20;

pub struct PtyRing {
    buf: VecDeque<u8>,
    /// Stream offset of `buf[0]`.
    start: u64,
    cap: usize,
}

/// What a client attaching at some offset receives first.
#[derive(Debug, PartialEq, Eq)]
pub enum Catchup {
    /// The bytes after the client's offset; `offset` is that of `data[0]`.
    Bytes { offset: u64, data: Vec<u8> },
    /// The client is behind the ring: discard what it has, then the ring from `offset`.
    Reset { offset: u64, data: Vec<u8> },
}

impl PtyRing {
    pub fn new(cap: usize) -> Self {
        PtyRing { buf: VecDeque::new(), start: 0, cap }
    }

    /// The offset one past the newest byte.
    pub fn end(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    /// Appends output and returns the offset of its first byte.
    pub fn push(&mut self, data: &[u8]) -> u64 {
        let offset = self.end();
        self.buf.extend(data);
        let excess = self.buf.len().saturating_sub(self.cap);
        if excess > 0 {
            self.buf.drain(..excess);
            self.start += excess as u64;
        }
        offset
    }

    /// Catch-up for a client that has seen everything before `offset` (`None`: a new client).
    pub fn after(&self, offset: Option<u64>) -> Catchup {
        match offset {
            Some(o) if o >= self.start && o <= self.end() => {
                let skip = (o - self.start) as usize;
                Catchup::Bytes { offset: o, data: self.buf.iter().skip(skip).copied().collect() }
            }
            _ => Catchup::Reset { offset: self.start, data: self.buf.iter().copied().collect() },
        }
    }
}

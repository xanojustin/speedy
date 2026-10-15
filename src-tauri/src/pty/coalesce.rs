//! U4: output coalescer — flush on a 16 ms tick or 64 KB, whichever first (KTD3).
//!
//! Pure and clock-injected so the flush policy is unit-testable; the PTY's
//! coalescer thread drives it with real `Instant`s.

use std::time::{Duration, Instant};

pub const TICK: Duration = Duration::from_millis(16);
pub const SIZE_CAP: usize = 64 * 1024;

pub struct Coalescer {
    buf: Vec<u8>,
    tick: Duration,
    cap: usize,
    /// When the oldest unflushed byte arrived; the frame is due one tick later.
    first_at: Option<Instant>,
}

impl Default for Coalescer {
    fn default() -> Self {
        Self::new(TICK, SIZE_CAP)
    }
}

impl Coalescer {
    pub fn new(tick: Duration, cap: usize) -> Self {
        Coalescer { buf: Vec::new(), tick, cap, first_at: None }
    }

    /// Buffers `data`; returns a frame immediately when the size cap is reached.
    pub fn push(&mut self, data: &[u8], now: Instant) -> Option<Vec<u8>> {
        if data.is_empty() {
            return None;
        }
        if self.buf.is_empty() {
            self.first_at = Some(now);
        }
        self.buf.extend_from_slice(data);
        if self.buf.len() >= self.cap { self.flush() } else { None }
    }

    /// When the buffered bytes must be flushed, if any are buffered.
    pub fn deadline(&self) -> Option<Instant> {
        self.first_at.map(|t| t + self.tick)
    }

    /// Returns the buffered frame if its tick has elapsed.
    pub fn poll(&mut self, now: Instant) -> Option<Vec<u8>> {
        match self.deadline() {
            Some(due) if now >= due => self.flush(),
            _ => None,
        }
    }

    /// Returns whatever is buffered (used at EOF).
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        self.first_at = None;
        if self.buf.is_empty() { None } else { Some(std::mem::take(&mut self.buf)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_write_waits_for_the_tick_then_flushes() {
        let t0 = Instant::now();
        let mut c = Coalescer::default();
        assert_eq!(c.push(b"a", t0), None);
        assert_eq!(c.push(b"b", t0 + Duration::from_millis(5)), None);
        assert_eq!(c.deadline(), Some(t0 + TICK), "deadline is one tick after the first byte");
        assert_eq!(c.poll(t0 + Duration::from_millis(15)), None);
        assert_eq!(c.poll(t0 + TICK), Some(b"ab".to_vec()));
        assert_eq!(c.deadline(), None);
        assert_eq!(c.poll(t0 + TICK * 3), None, "nothing left to flush");
    }

    #[test]
    fn size_cap_flushes_before_the_tick() {
        let t0 = Instant::now();
        let mut c = Coalescer::default();
        assert_eq!(c.push(&vec![b'x'; SIZE_CAP - 1], t0), None);
        let frame = c.push(b"yz", t0).expect("cap reached flushes immediately");
        assert_eq!(frame.len(), SIZE_CAP + 1);
        assert_eq!(c.deadline(), None);
        // The next byte starts a fresh tick window.
        let t1 = t0 + Duration::from_millis(10);
        assert_eq!(c.push(b"q", t1), None);
        assert_eq!(c.deadline(), Some(t1 + TICK));
    }

    #[test]
    fn flush_returns_the_remainder_once() {
        let mut c = Coalescer::default();
        c.push(b"tail", Instant::now());
        assert_eq!(c.flush(), Some(b"tail".to_vec()));
        assert_eq!(c.flush(), None);
    }
}

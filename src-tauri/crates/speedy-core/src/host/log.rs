//! U5: a thread's replayable event log, kept in the agent's memory (KTD5).
//!
//! Every event a thread emits is appended with its own `seq`, which replaces the actor's.
//! A cursor `(epoch, seq)` names the last event a client saw. `epoch` changes each time the
//! agent starts, and nothing here outlives the process: after a restart the snapshot plus
//! the session JSONL are the way back. Partial `stream_event`s are dropped once their message
//! completes, and the oldest events go first when the log passes its byte cap.

use std::collections::VecDeque;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The last event a client saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub epoch: u64,
    pub seq: u64,
}

/// What a client needs to catch up from its cursor.
#[derive(Debug)]
pub enum Replay {
    /// Every retained event after the cursor, in order.
    Events(Vec<Arc<Value>>),
    /// The log can't answer exactly; the client needs a snapshot.
    Snapshot,
}

struct Entry {
    seq: u64,
    event: Arc<Value>,
    bytes: usize,
}

pub struct EventLog {
    epoch: u64,
    next_seq: u64,
    entries: VecDeque<Entry>,
    bytes: usize,
    cap: usize,
    /// The newest seq evicted for space; a cursor before it has a gap.
    evicted_through: u64,
}

impl EventLog {
    pub fn new(epoch: u64, cap_bytes: usize) -> Self {
        EventLog { epoch, next_seq: 1, entries: VecDeque::new(), bytes: 0, cap: cap_bytes, evicted_through: 0 }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The seq of the newest event, 0 when empty.
    pub fn last_seq(&self) -> u64 {
        self.next_seq - 1
    }

    /// Stamps `event` with the next seq, appends it, and returns the stamped event.
    pub fn push(&mut self, mut event: Value) -> Arc<Value> {
        let seq = self.next_seq;
        self.next_seq += 1;
        if let Some(obj) = event.as_object_mut() {
            obj.insert("seq".into(), seq.into());
        }
        match raw_type(&event) {
            Some("assistant") => {
                let parent = event["raw"]["parent_tool_use_id"].clone();
                self.drop_partials(|e| e["raw"]["parent_tool_use_id"] == parent);
            }
            Some("result") => self.drop_partials(|_| true),
            _ => {}
        }
        let event = Arc::new(event);
        let bytes = serde_json::to_vec(&*event).map_or(0, |b| b.len());
        self.entries.push_back(Entry { seq, event: event.clone(), bytes });
        self.bytes += bytes;
        while self.bytes > self.cap && self.entries.len() > 1 {
            let old = self.entries.pop_front().expect("len > 1");
            self.bytes -= old.bytes;
            self.evicted_through = old.seq;
        }
        event
    }

    pub fn after(&self, cursor: Option<Cursor>) -> Replay {
        match cursor {
            Some(c) if c.epoch == self.epoch && c.seq >= self.evicted_through => Replay::Events(
                self.entries.iter().filter(|e| e.seq > c.seq).map(|e| e.event.clone()).collect(),
            ),
            _ => Replay::Snapshot,
        }
    }

    /// Partials of messages still in progress, oldest first (part of a snapshot).
    pub fn partials(&self) -> Vec<Arc<Value>> {
        self.entries.iter().filter(|e| is_partial(&e.event)).map(|e| e.event.clone()).collect()
    }

    fn drop_partials(&mut self, mut matches: impl FnMut(&Value) -> bool) {
        let mut freed = 0;
        self.entries.retain(|e| {
            let drop = is_partial(&e.event) && matches(&e.event);
            if drop {
                freed += e.bytes;
            }
            !drop
        });
        self.bytes -= freed;
    }
}

fn raw_type(event: &Value) -> Option<&str> {
    (event["kind"] == "message").then(|| event["raw"]["type"].as_str()).flatten()
}

fn is_partial(event: &Value) -> bool {
    raw_type(event) == Some("stream_event")
}

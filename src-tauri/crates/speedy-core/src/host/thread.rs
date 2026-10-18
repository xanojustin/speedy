//! U5: one thread's live state on the host: its actor, replay log, queue, and subscribers.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use super::log::{Cursor, EventLog, Replay};
use super::snapshot::LiveEvents;
use super::store::QueueItem;
use super::{LOG_CAP_BYTES, ThreadReplay};
use crate::claude::ThreadStatus;
use crate::claude::actor::ClaudeActor;

pub(super) struct ThreadRuntime {
    pub live: Mutex<Live>,
    actor: Mutex<Option<ClaudeActor>>,
    /// Serializes starts, so concurrent sends spawn one `claude`.
    pub starting: tokio::sync::Mutex<()>,
}

pub(super) struct Live {
    log: EventLog,
    events: LiveEvents,
    pub queue: Vec<QueueItem>,
    /// A user message was written and its turn's `result` hasn't arrived.
    pub in_flight: bool,
    subscribers: Vec<UnboundedSender<Arc<Value>>>,
}

impl Live {
    /// Whether a new message goes straight to the CLI rather than the queue.
    pub fn can_send_now(&self) -> bool {
        self.events.status == ThreadStatus::Idle && !self.in_flight && self.queue.is_empty()
    }
}

impl ThreadRuntime {
    pub fn new(epoch: u64, queue: Vec<QueueItem>) -> Self {
        ThreadRuntime {
            live: Mutex::new(Live {
                log: EventLog::new(epoch, LOG_CAP_BYTES),
                events: LiveEvents::default(),
                queue,
                in_flight: false,
                subscribers: vec![],
            }),
            actor: Mutex::new(None),
            starting: tokio::sync::Mutex::new(()),
        }
    }

    pub fn actor(&self) -> Option<ClaudeActor> {
        self.actor.lock().clone()
    }

    pub fn set_actor(&self, actor: ClaudeActor) {
        *self.actor.lock() = Some(actor);
    }

    pub fn status(&self) -> ThreadStatus {
        self.live.lock().events.status
    }

    /// Logs the event under the next seq and sends it to every subscriber.
    pub fn publish(&self, event: Value) -> Arc<Value> {
        let mut live = self.live.lock();
        let event = live.log.push(event);
        live.events.observe(&event);
        live.subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        event
    }

    /// Registers a subscriber atomically with its replay, so no event falls in between.
    pub fn subscribe(
        &self,
        cursor: Option<Cursor>,
        session_id: impl FnOnce() -> Option<String>,
    ) -> (ThreadReplay, UnboundedReceiver<Arc<Value>>) {
        let (tx, rx) = unbounded_channel();
        let mut live = self.live.lock();
        let replay = match live.log.after(cursor) {
            Replay::Events(events) => ThreadReplay::Events(events),
            Replay::Snapshot => ThreadReplay::Snapshot(live.events.snapshot(
                live.log.epoch(),
                live.log.last_seq(),
                session_id(),
                live.queue.clone(),
                live.log.partials(),
            )),
        };
        live.subscribers.push(tx);
        (replay, rx)
    }
}

//! U5: what a client gets instead of a replay when the log can't answer its cursor (KTD5).
//!
//! A snapshot is a short list of the thread's live events, in the shapes the client already
//! reduces: the `initialized` response, the CLI's `system/init`, the session binding, every
//! pending permission prompt (with any refreshed diff), partials of messages still streaming,
//! and the current status last. The client seeds history from the session JSONL first.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use super::store::QueueItem;
use crate::claude::ThreadStatus;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub epoch: u64,
    /// Resume the live stream after this seq.
    pub seq: u64,
    pub session_id: Option<String>,
    pub queue: Vec<QueueItem>,
    pub events: Vec<Arc<Value>>,
}

/// The latest of each event a snapshot replays, tracked as events are published.
#[derive(Default)]
pub struct LiveEvents {
    pub status: ThreadStatus,
    initialized: Option<Arc<Value>>,
    system_init: Option<Arc<Value>>,
    session_bound: Option<Arc<Value>>,
    status_event: Option<Arc<Value>>,
    pending: BTreeMap<String, Arc<Value>>,
}

impl LiveEvents {
    pub fn observe(&mut self, event: &Arc<Value>) {
        let request_id = || event["request_id"].as_str().unwrap_or_default().to_owned();
        match event["kind"].as_str() {
            Some("initialized") => self.initialized = Some(event.clone()),
            Some("session_bound") => self.session_bound = Some(event.clone()),
            Some("message") if event["raw"]["type"] == "system" && event["raw"]["subtype"] == "init" => {
                self.system_init = Some(event.clone());
            }
            Some("status") => {
                if let Ok(status) = serde_json::from_value(event["status"].clone()) {
                    self.status = status;
                }
                self.status_event = Some(event.clone());
            }
            Some("permission_request") => {
                self.pending.insert(request_id(), event.clone());
            }
            Some("permission_resolved") => {
                self.pending.remove(&request_id());
            }
            Some("diff_refreshed") => {
                if let Some(prompt) = self.pending.get_mut(&request_id()) {
                    let mut updated = (**prompt).clone();
                    updated["diff"] = event["diff"].clone();
                    *prompt = Arc::new(updated);
                }
            }
            _ => {}
        }
    }

    pub fn snapshot(&self, epoch: u64, seq: u64, session_id: Option<String>, queue: Vec<QueueItem>, partials: Vec<Arc<Value>>) -> ThreadSnapshot {
        let events = [&self.initialized, &self.system_init, &self.session_bound]
            .into_iter()
            .flatten()
            .cloned()
            .chain(self.pending.values().cloned())
            .chain(partials)
            .chain(self.status_event.clone())
            .collect();
        ThreadSnapshot { epoch, seq, session_id, queue, events }
    }
}

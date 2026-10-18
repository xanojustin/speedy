//! U8: thread status transitions for attention, from a host's event stream (KTD13). A host
//! snapshot (every connect and reconnect) records statuses silently; only a live
//! `thread_status` change is a transition, so catching up never fires a burst of banners.

use std::collections::HashMap;

use serde_json::Value;
use speedy_core::claude::ThreadStatus;

#[derive(Default)]
pub struct StatusTracker {
    last: HashMap<String, ThreadStatus>,
}

impl StatusTracker {
    /// `(thread_id, from, to)` when `event` is a live status change.
    pub fn observe(&mut self, event: &Value) -> Option<(String, ThreadStatus, ThreadStatus)> {
        match event["kind"].as_str()? {
            "host_snapshot" => {
                let statuses = &event["snapshot"]["statuses"];
                self.last = serde_json::from_value(statuses.clone()).unwrap_or_default();
                None
            }
            "thread_status" => {
                let id = event["id"].as_str()?.to_owned();
                let to: ThreadStatus = serde_json::from_value(event["status"].clone()).ok()?;
                let from = self.last.insert(id.clone(), to).unwrap_or_default();
                (from != to).then_some((id, from, to))
            }
            _ => None,
        }
    }
}

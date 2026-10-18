//! U4: the msgpack-encoded messages carried by Control, Request, Response and Event
//! frames, and `Hello` version negotiation (KTD4, KTD5, KTD9).
//!
//! RPC params and results, and event bodies, are the JSON values the webview sends and
//! receives, so the app forwards them without knowing their types.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Oldest protocol version this build speaks.
pub const PROTOCOL_MIN: u32 = 1;
/// Newest protocol version this build speaks.
pub const PROTOCOL_MAX: u32 = 1;

/// Sent by both sides first. Clients send `None` for `host_id` and `epoch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol_min: u32,
    pub protocol_max: u32,
    pub agent_version: String,
    pub build_sha: String,
    pub host_id: Option<String>,
    /// Changes every time the agent starts; the first half of an event cursor (KTD5).
    pub epoch: Option<u64>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Control {
    Hello(Hello),
    Ping {
        nonce: u64,
    },
    Pong {
        nonce: u64,
    },
    /// The client overflowed its outbound queue on `stream_id`; it resumes by
    /// resubscribing after `last_sent_seq` (KTD7).
    Lagged {
        stream_id: u32,
        last_sent_seq: u64,
    },
    Shutdown,
}

/// An RPC call. `method` and `params` match the Tauri command and its camelCase args.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    pub params: serde_json::Value,
}

/// The answer to the [`Request`] with the same `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    pub result: Result<serde_json::Value, String>,
}

/// One subscription event, sent on that subscription's stream id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub epoch: u64,
    pub seq: u64,
    pub event: serde_json::Value,
}

/// The two `Hello`s share no protocol version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Incompatible {
    /// Our `(protocol_min, protocol_max)`.
    pub ours: (u32, u32),
    /// The peer's `(protocol_min, protocol_max)`.
    pub theirs: (u32, u32),
}

impl fmt::Display for Incompatible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "incompatible protocol versions: we speak {}..={}, the peer speaks {}..={}",
            self.ours.0, self.ours.1, self.theirs.0, self.theirs.1
        )
    }
}

impl std::error::Error for Incompatible {}

/// The highest protocol version both sides speak.
pub fn negotiate(ours: &Hello, theirs: &Hello) -> Result<u32, Incompatible> {
    let lo = ours.protocol_min.max(theirs.protocol_min);
    let hi = ours.protocol_max.min(theirs.protocol_max);
    if lo <= hi {
        Ok(hi)
    } else {
        Err(Incompatible {
            ours: (ours.protocol_min, ours.protocol_max),
            theirs: (theirs.protocol_min, theirs.protocol_max),
        })
    }
}

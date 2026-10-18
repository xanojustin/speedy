//! U3: thin stream-json envelope parsing and the outgoing message shapes (KTD4).
//! Only the envelope is interpreted; everything else passes through as raw JSON.

use serde_json::{Value, json};

/// The few envelope fields the actor routes on.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Envelope<'a> {
    pub kind: Option<&'a str>,
    pub subtype: Option<&'a str>,
    /// Top-level `request_id`, or `response.request_id` for control responses.
    pub request_id: Option<&'a str>,
    /// `request.subtype` of a control request.
    pub request_subtype: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

pub fn envelope(v: &Value) -> Envelope<'_> {
    Envelope {
        kind: v.get("type").and_then(Value::as_str),
        subtype: v.get("subtype").and_then(Value::as_str),
        request_id: v
            .get("request_id")
            .or_else(|| v.get("response").and_then(|r| r.get("request_id")))
            .and_then(Value::as_str),
        request_subtype: v.get("request").and_then(|r| r.get("subtype")).and_then(Value::as_str),
        session_id: v.get("session_id").and_then(Value::as_str),
    }
}

/// The CLI's answer to one of our control requests.
pub fn control_response_result(v: &Value) -> Result<Value, String> {
    let response = &v["response"];
    if response["subtype"] == "success" {
        Ok(response.get("response").cloned().unwrap_or(Value::Null))
    } else {
        Err(response["error"].as_str().unwrap_or("control request failed").to_owned())
    }
}

pub fn user_message(content: Value) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": null,
        "session_id": "",
    })
}

pub fn control_request(request_id: &str, request: Value) -> Value {
    json!({"type": "control_request", "request_id": request_id, "request": request})
}

pub fn control_success(request_id: &str, response: Value) -> Value {
    json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request_id, "response": response},
    })
}

pub fn control_error(request_id: &str, error: &str) -> Value {
    json!({
        "type": "control_response",
        "response": {"subtype": "error", "request_id": request_id, "error": error},
    })
}

/// Splits a byte stream into lines, holding a partial line until its newline.
#[derive(Default)]
pub struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    /// Feeds a chunk and calls `on_line` for every completed line (without `\n` / `\r\n`).
    pub fn push(&mut self, mut chunk: &[u8], mut on_line: impl FnMut(&[u8])) {
        while let Some(nl) = chunk.iter().position(|&b| b == b'\n') {
            let (head, rest) = chunk.split_at(nl);
            if self.partial.is_empty() {
                on_line(trim_cr(head));
            } else {
                self.partial.extend_from_slice(head);
                on_line(trim_cr(&self.partial));
                self.partial.clear();
            }
            chunk = &rest[1..];
        }
        self.partial.extend_from_slice(chunk);
    }

    /// The trailing unterminated line at EOF, if any.
    pub fn finish(&mut self) -> Option<Vec<u8>> {
        (!self.partial.is_empty()).then(|| std::mem::take(&mut self.partial))
    }
}

fn trim_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

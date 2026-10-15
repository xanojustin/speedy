//! U5/U11: lists and reads the CLI's own sessions under `~/.claude/projects` (KTD6). STUB bodies.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    /// Last `custom-title`, else last `ai-title`, else first user message.
    pub title: String,
    pub created_ms: u64,
    pub modified_ms: u64,
    pub file_path: String,
}

#[tauri::command]
pub fn sessions_list(_project_path: String) -> Result<Vec<SessionMeta>, String> {
    Ok(vec![])
}

/// Every parseable JSONL line of a session, in order, for seeding a resumed transcript.
#[tauri::command]
pub fn session_load(_project_path: String, _session_id: String) -> Result<Vec<Value>, String> {
    Err("session index not implemented".into())
}

/// Appends a `custom-title` entry in the CLI's own format (no live actor).
#[tauri::command]
pub fn session_rename_offline(_project_path: String, _session_id: String, _title: String) -> Result<(), String> {
    Err("session index not implemented".into())
}

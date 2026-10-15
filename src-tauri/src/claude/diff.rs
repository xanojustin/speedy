//! U10: diffs for Edit/Write/MultiEdit permission requests (KTD5). STUB.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub is_new_file: bool,
    /// Unified diff text (`---`/`+++`/`@@` hunks).
    pub unified: String,
    /// Fingerprint of the on-disk contents the diff was computed against; a
    /// mismatch at decision time means the diff is stale.
    pub base_fingerprint: String,
}

/// Computes the proposed change for a file-editing tool, or None for other tools.
pub fn diff_for_tool(_tool_name: &str, _input: &Value, _cwd: &Path) -> Option<Vec<FileDiff>> {
    None
}

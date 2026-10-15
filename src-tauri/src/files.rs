//! U9: gitignore-aware fuzzy file search for @-mentions. STUB.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// Path relative to the project root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn files_search(
    _root: String,
    _query: String,
    _limit: Option<usize>,
    _respect_gitignore: Option<bool>,
) -> Result<Vec<FileHit>, String> {
    Ok(vec![])
}

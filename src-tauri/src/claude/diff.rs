//! U10: diffs for Edit/Write/MultiEdit permission requests (KTD5).
//!
//! The proposed content is computed from the tool input against the file on
//! disk. `base_fingerprint` lets the actor detect, at decision time, that the
//! file changed after the diff was shown.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use similar::TextDiff;

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

const ABSENT_FINGERPRINT: &str = "absent";

/// Computes the proposed change for a file-editing tool, or None for other tools.
pub fn diff_for_tool(tool_name: &str, input: &Value, cwd: &Path) -> Option<Vec<FileDiff>> {
    let path = resolve(input.get("file_path")?.as_str()?, cwd);
    let current = std::fs::read(&path).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let base = current.as_deref().unwrap_or("");
    let proposed = match tool_name {
        "Write" => input.get("content")?.as_str()?.to_owned(),
        "Edit" => apply_edit(base, input)?,
        "MultiEdit" => input
            .get("edits")?
            .as_array()?
            .iter()
            .try_fold(base.to_owned(), |text, edit| apply_edit(&text, edit))?,
        _ => return None,
    };
    let shown = path.to_string_lossy().into_owned();
    let unified = TextDiff::from_lines(base, proposed.as_str())
        .unified_diff()
        .context_radius(3)
        .header(&shown, &shown)
        .to_string();
    Some(vec![FileDiff {
        path: shown,
        is_new_file: current.is_none(),
        unified,
        base_fingerprint: current.as_deref().map_or_else(|| ABSENT_FINGERPRINT.to_owned(), fingerprint),
    }])
}

/// Recomputes the diff and returns it only when any file's base fingerprint
/// differs from the one that was shown (KTD5 staleness check).
pub fn refresh_if_stale(tool_name: &str, input: &Value, cwd: &Path, shown: &[FileDiff]) -> Option<Vec<FileDiff>> {
    let fresh = diff_for_tool(tool_name, input, cwd)?;
    let same = fresh.len() == shown.len()
        && fresh
            .iter()
            .zip(shown)
            .all(|(a, b)| a.path == b.path && a.base_fingerprint == b.base_fingerprint);
    (!same).then_some(fresh)
}

fn resolve(file_path: &str, cwd: &Path) -> PathBuf {
    let p = Path::new(file_path);
    if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }
}

fn apply_edit(text: &str, edit: &Value) -> Option<String> {
    let old = edit.get("old_string")?.as_str()?;
    let new = edit.get("new_string")?.as_str()?;
    let all = edit.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
    Some(if all { text.replace(old, new) } else { text.replacen(old, new, 1) })
}

/// FNV-1a over the contents, plus the length. Only compared within one app run.
fn fingerprint(contents: &str) -> String {
    let hash = contents
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:016x}-{}", contents.len())
}

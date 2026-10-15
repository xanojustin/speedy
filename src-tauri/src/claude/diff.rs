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
/// Above this, either side is summarized instead of diffed so a huge file
/// (or a `replace_all` blow-up) can't stall the actor.
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES: usize = 64 * 1024 * 1024;
const DIFF_DEADLINE: std::time::Duration = std::time::Duration::from_millis(500);

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
    let unified = if base.len() > MAX_DIFF_BYTES || proposed.len() > MAX_DIFF_BYTES {
        format!(
            "--- {shown}\n+++ {shown}\n(file too large to show a diff: {} bytes → {} bytes)\n",
            base.len(),
            proposed.len()
        )
    } else {
        TextDiff::configure()
            .timeout(DIFF_DEADLINE)
            .diff_lines(base, proposed.as_str())
            .unified_diff()
            .context_radius(3)
            .header(&shown, &shown)
            .to_string()
    };
    Some(vec![FileDiff {
        path: shown,
        is_new_file: current.is_none(),
        unified,
        base_fingerprint: current.as_deref().map_or_else(|| ABSENT_FINGERPRINT.to_owned(), fingerprint),
    }])
}

/// Returns a refreshed diff when any shown file's on-disk contents changed since
/// it was shown (KTD5). Fails closed: if the change can't be re-diffed, the
/// refreshed list is empty, which still blocks the allow.
pub fn refresh_if_stale(tool_name: &str, input: &Value, cwd: &Path, shown: &[FileDiff]) -> Option<Vec<FileDiff>> {
    let changed = shown.iter().any(|d| current_fingerprint(Path::new(&d.path)) != d.base_fingerprint);
    changed.then(|| diff_for_tool(tool_name, input, cwd).unwrap_or_default())
}

fn current_fingerprint(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(b) => fingerprint(&String::from_utf8_lossy(&b)),
        Err(_) => ABSENT_FINGERPRINT.to_owned(),
    }
}

fn resolve(file_path: &str, cwd: &Path) -> PathBuf {
    let p = Path::new(file_path);
    if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }
}

fn apply_edit(text: &str, edit: &Value) -> Option<String> {
    let old = edit.get("old_string")?.as_str()?;
    let new = edit.get("new_string")?.as_str()?;
    let all = edit.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
    // The CLI rejects an empty old_string; refusing it here also stops `replace("", …)`
    // from inserting between every character.
    if old.is_empty() {
        return None;
    }
    if all {
        // Skip the preview rather than materialize a pathological expansion.
        let grown = text.matches(old).count().saturating_mul(new.len());
        if grown.saturating_add(text.len()) > MAX_EXPANDED_BYTES {
            return None;
        }
        Some(text.replace(old, new))
    } else {
        Some(text.replacen(old, new, 1))
    }
}

/// FNV-1a over the contents, plus the length. Only compared within one app run.
fn fingerprint(contents: &str) -> String {
    let hash = contents
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:016x}-{}", contents.len())
}

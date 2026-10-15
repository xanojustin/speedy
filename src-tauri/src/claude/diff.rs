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

/// The on-disk side of a diff, read without trusting the (model-chosen) path:
/// only regular files up to `MAX_DIFF_BYTES` are read.
enum Current {
    Absent,
    Text(String),
    /// Exists but isn't read (not a regular file, too large, unreadable):
    /// summarized, and fingerprinted from metadata so staleness still fails closed.
    Opaque { why: String, fingerprint: String },
}

impl Current {
    fn fingerprint(&self) -> String {
        match self {
            Current::Absent => ABSENT_FINGERPRINT.to_owned(),
            Current::Text(text) => fingerprint(text),
            Current::Opaque { fingerprint, .. } => fingerprint.clone(),
        }
    }
}

fn read_current(path: &Path) -> Current {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;

    let Ok(meta) = std::fs::metadata(path) else { return Current::Absent };
    if !meta.is_file() {
        return Current::Opaque { why: "not a regular file".into(), fingerprint: meta_fingerprint(&meta) };
    }
    if meta.len() > MAX_DIFF_BYTES as u64 {
        return too_large(&meta);
    }
    // O_NONBLOCK: if the path was swapped for a FIFO since the check, opening must not block.
    let opened = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path);
    let mut file = match opened {
        Ok(f) => f,
        Err(e) => return Current::Opaque { why: format!("unreadable: {e}"), fingerprint: meta_fingerprint(&meta) },
    };
    match file.metadata() {
        Ok(m) if m.is_file() => {}
        Ok(m) => return Current::Opaque { why: "not a regular file".into(), fingerprint: meta_fingerprint(&m) },
        Err(e) => return Current::Opaque { why: format!("unreadable: {e}"), fingerprint: meta_fingerprint(&meta) },
    }
    // Bounded even if the file grows after the size check.
    let mut bytes = Vec::new();
    match (&mut file).take(MAX_DIFF_BYTES as u64 + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() <= MAX_DIFF_BYTES => Current::Text(String::from_utf8_lossy(&bytes).into_owned()),
        Ok(_) => file.metadata().map_or_else(|_| too_large(&meta), |m| too_large(&m)),
        Err(e) => Current::Opaque { why: format!("unreadable: {e}"), fingerprint: meta_fingerprint(&meta) },
    }
}

fn too_large(meta: &std::fs::Metadata) -> Current {
    Current::Opaque {
        why: format!("file too large to show a diff: {} bytes", meta.len()),
        fingerprint: meta_fingerprint(meta),
    }
}

/// Identity, size and timestamps; changes whenever the file is rewritten or replaced.
fn meta_fingerprint(meta: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "meta-{}-{}-{:o}-{}-{}.{}-{}.{}",
        meta.dev(),
        meta.ino(),
        meta.mode(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec()
    )
}

/// Computes the proposed change for a file-editing tool, or None for other tools.
pub fn diff_for_tool(tool_name: &str, input: &Value, cwd: &Path) -> Option<Vec<FileDiff>> {
    if !matches!(tool_name, "Write" | "Edit" | "MultiEdit") {
        return None;
    }
    let path = resolve(input.get("file_path")?.as_str()?, cwd);
    let shown = path.to_string_lossy().into_owned();
    let current = read_current(&path);
    let base = match &current {
        Current::Text(text) => text.as_str(),
        Current::Absent => "",
        Current::Opaque { why, fingerprint } => {
            // Validate the input as usual; there's just no base text to apply it to.
            let proposed_size = match tool_name {
                "Write" => format!(" → {} bytes", input.get("content")?.as_str()?.len()),
                "Edit" => {
                    apply_edit("", input)?;
                    String::new()
                }
                _ => {
                    for edit in input.get("edits")?.as_array()? {
                        apply_edit("", edit)?;
                    }
                    String::new()
                }
            };
            return Some(vec![FileDiff {
                unified: format!("--- {shown}\n+++ {shown}\n({why}{proposed_size})\n"),
                path: shown,
                is_new_file: false,
                base_fingerprint: fingerprint.clone(),
            }]);
        }
    };
    let proposed = match tool_name {
        "Write" => input.get("content")?.as_str()?.to_owned(),
        "Edit" => apply_edit(base, input)?,
        _ => input
            .get("edits")?
            .as_array()?
            .iter()
            .try_fold(base.to_owned(), |text, edit| apply_edit(&text, edit))?,
    };
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
        is_new_file: matches!(current, Current::Absent),
        unified,
        base_fingerprint: current.fingerprint(),
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
    read_current(path).fingerprint()
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

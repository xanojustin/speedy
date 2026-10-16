//! File explorer: list a project's tree one directory at a time, read and save text files, and
//! show what changed against git `HEAD`.
//!
//! Every path the webview sends is relative to the project root and is resolved without trusting
//! it: absolute paths and `..` are refused, and the canonical result must stay under the root
//! (so a symlink can't point a save outside the project).

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use ignore::WalkBuilder;
use serde::Serialize;
use similar::TextDiff;

use crate::claude::diff::FileDiff;

/// Larger files aren't opened in the editor.
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const DIFF_DEADLINE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Path relative to the project root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
    /// Matched by a gitignore rule; listed so it can be shown dimmed.
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// Path relative to the project root, `/`-separated.
    pub path: String,
    /// `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked, `C` conflicted.
    pub status: String,
}

#[tauri::command]
pub async fn explorer_list(root: String, dir: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list(Path::new(&root), &dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn explorer_read(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read(Path::new(&root), &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn explorer_write(root: String, path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write(Path::new(&root), &path, &content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn explorer_git_status(root: String) -> Result<Vec<GitChange>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(git_status(Path::new(&root))))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn explorer_git_diff(root: String, path: String) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff(Path::new(&root), &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Resolves `rel` under `root`; the target must exist and stay inside the root.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("invalid path: {rel}"));
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let full = root.join(rel_path).canonicalize().map_err(|e| e.to_string())?;
    if !full.starts_with(&root) {
        return Err(format!("path is outside the project: {rel}"));
    }
    Ok(full)
}

/// The direct children of `dir` (relative to `root`; `""` is the root), folders first.
/// Gitignored entries are included and flagged; `.ignore` files still hide entries outright.
pub fn list(root: &Path, dir: &str) -> Result<Vec<DirEntry>, String> {
    let base = resolve(root, dir)?;
    // Rules only match an entry's own path, so everything under an ignored folder is ignored too.
    let under_ignored = ignored_ancestor(root, dir)?;
    let visible = children(&base, true);
    let mut out: Vec<DirEntry> = children(&base, false)
        .into_iter()
        .map(|(full, name)| {
            let path = if dir.is_empty() { name.clone() } else { format!("{}/{name}", dir.trim_end_matches('/')) };
            // Symlinked folders are listed as folders (follow_links only stops the walk descending).
            let is_dir = full.is_dir();
            let ignored = under_ignored || !visible.iter().any(|(p, _)| *p == full);
            DirEntry { name, path, is_dir, ignored }
        })
        .collect();
    out.sort_by_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(out)
}

/// Whether `dir` or a folder above it (below `root`) is gitignored.
fn ignored_ancestor(root: &Path, dir: &str) -> Result<bool, String> {
    let mut parent = String::new();
    for name in dir.split('/').filter(|n| !n.is_empty() && *n != ".") {
        let base = resolve(root, &parent)?;
        if !children(&base, true).iter().any(|(_, n)| n == name) {
            return Ok(true);
        }
        parent = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
    }
    Ok(false)
}

/// One level of `base` as `(path, name)`, honouring gitignore rules when `gitignore` is set.
fn children(base: &Path, gitignore: bool) -> Vec<(PathBuf, String)> {
    WalkBuilder::new(base)
        .max_depth(Some(1))
        .hidden(false)
        .parents(true)
        .ignore(true)
        .git_ignore(gitignore)
        .git_global(gitignore)
        .git_exclude(gitignore)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != ".DS_Store")
        .build()
        .flatten()
        .filter(|e| e.depth() > 0)
        .map(|e| (e.path().to_path_buf(), e.file_name().to_string_lossy().into_owned()))
        .collect()
}

pub fn read(root: &Path, rel: &str) -> Result<String, String> {
    let full = resolve(root, rel)?;
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("file is too large to open ({} KB)", meta.len() / 1024));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "binary file".to_string())
}

/// Saves over an existing file (the explorer edits files; it doesn't create them).
pub fn write(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    if !std::fs::metadata(&full).map_err(|e| e.to_string())?.is_file() {
        return Err("not a file".into());
    }
    std::fs::write(&full, content).map_err(|e| e.to_string())
}

fn git(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// The project's prefix inside its repository (`""` at the top level, else `sub/dir/`).
fn repo_prefix(root: &Path) -> Option<String> {
    let out = git(root, &["rev-parse", "--show-prefix"])?;
    Some(String::from_utf8_lossy(&out).trim().to_string())
}

/// Uncommitted changes under `root`. Empty when `root` isn't in a git repository.
pub fn git_status(root: &Path) -> Vec<GitChange> {
    let Some(prefix) = repo_prefix(root) else { return Vec::new() };
    let Some(out) = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]) else {
        return Vec::new();
    };
    let mut changes = Vec::new();
    let mut records = out.split(|b| *b == 0).filter(|r| !r.is_empty());
    while let Some(rec) = records.next() {
        if rec.len() < 4 {
            continue;
        }
        let (x, y) = (rec[0], rec[1]);
        let path = String::from_utf8_lossy(&rec[3..]).into_owned();
        // A rename/copy record is followed by its source path.
        if x == b'R' || x == b'C' {
            records.next();
        }
        let status = match (x, y) {
            (b'?', b'?') => "U",
            (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => "C",
            (b'R', _) => "R",
            (b'A', _) => "A",
            (b'D', _) | (_, b'D') => "D",
            _ => "M",
        };
        // Porcelain paths are relative to the repository top level.
        let Some(path) = path.strip_prefix(&prefix) else { continue };
        changes.push(GitChange { path: path.to_string(), status: status.into() });
    }
    changes
}

/// The working copy of `rel` against its `HEAD` version (an untracked file diffs against nothing).
pub fn git_diff(root: &Path, rel: &str) -> Result<FileDiff, String> {
    let current = read(root, rel)?;
    let head = git(root, &["show", &format!("HEAD:./{rel}")]);
    let is_new_file = head.is_none();
    let base = head.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let unified = TextDiff::configure()
        .timeout(DIFF_DEADLINE)
        .diff_lines(base.as_str(), current.as_str())
        .unified_diff()
        .context_radius(3)
        .header(rel, rel)
        .to_string();
    Ok(FileDiff { path: rel.to_string(), is_new_file, unified, base_fingerprint: String::new() })
}

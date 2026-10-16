//! Per-thread git worktrees: a thread can start on its own branch in its own checkout, so
//! parallel threads in one repository don't share a working tree.
//!
//! Worktrees live under Speedy's data folder (`worktrees/<repo>/<branch>`), outside the
//! repository, so they never show up in the project's own `git status`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// The thread's working directory: the worktree plus the project's prefix in the repository.
    pub path: String,
    pub branch: String,
}

#[tauri::command]
pub async fn worktree_create(root: String, branch: String) -> Result<Worktree, String> {
    let base = crate::state::default_state_dir().join("worktrees");
    tauri::async_runtime::spawn_blocking(move || create(Path::new(&root), &branch, &base))
        .await
        .map_err(|e| e.to_string())?
}

/// A worktree a cleanup would remove, shown to the user before anything happens.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Unused {
    pub path: String,
    /// None for a detached `HEAD`.
    pub branch: Option<String>,
    /// Uncommitted or untracked changes: git won't remove it, so the cleanup leaves it.
    pub dirty: bool,
    /// The branch holds no unmerged commits, so the cleanup deletes it too.
    pub merged: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub removed: Vec<String>,
    /// Worktrees git refused to remove (changed since the preview, locked, …), with git's reason.
    pub skipped: Vec<Skipped>,
    pub deleted_branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[tauri::command]
pub async fn worktree_unused(root: String, keep: Vec<String>) -> Result<Vec<Unused>, String> {
    let base = crate::state::default_state_dir().join("worktrees");
    tauri::async_runtime::spawn_blocking(move || unused(Path::new(&root), &keep, &base))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn worktree_clean(root: String, paths: Vec<String>) -> Result<CleanReport, String> {
    let base = crate::state::default_state_dir().join("worktrees");
    tauri::async_runtime::spawn_blocking(move || clean(Path::new(&root), &paths, &base))
        .await
        .map_err(|e| e.to_string())?
}

/// Runs git in `dir`; on failure returns git's own message.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(err.strip_prefix("fatal: ").unwrap_or(&err).to_string())
    }
}

/// Checks out `branch` in a new worktree under `base`, creating the branch from the project's
/// current `HEAD` when it doesn't exist yet.
pub fn create(root: &Path, branch: &str, base: &Path) -> Result<Worktree, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Enter a branch name".into());
    }
    git(root, &["check-ref-format", "--branch", branch]).map_err(|_| format!("“{branch}” isn't a valid branch name"))?;
    let top = PathBuf::from(git(root, &["rev-parse", "--show-toplevel"]).map_err(|_| "This project isn't in a git repository")?);
    let prefix = git(root, &["rev-parse", "--show-prefix"])?;
    let repo = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let dest = free_dir(&base.join(repo), &slug(branch));
    std::fs::create_dir_all(dest.parent().expect("dest has a parent")).map_err(|e| e.to_string())?;
    let dest_str = dest.to_string_lossy();

    let exists = git(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        git(root, &["worktree", "add", &dest_str, branch])?;
    } else {
        git(root, &["worktree", "add", "-b", branch, &dest_str, "HEAD"])?;
    }
    Ok(Worktree { path: dest.join(prefix).to_string_lossy().trim_end_matches('/').to_string(), branch: branch.into() })
}

/// A folder name for the branch: `justin/DEV-1/thing` → `justin-DEV-1-thing`.
fn slug(branch: &str) -> String {
    branch.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect()
}

/// `dir/name`, or `dir/name-2`, `-3`, … when it's taken.
fn free_dir(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    (2..).map(|n| dir.join(format!("{name}-{n}"))).find(|p| !p.exists()).expect("unbounded range")
}

/// Git reports resolved paths; resolve ours too (macOS temp and data folders sit behind symlinks).
fn real(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// The repository's worktrees under `base` as (path, branch). `git worktree list --porcelain`
/// prints one block per worktree: `worktree <path>`, `HEAD <sha>`, then `branch refs/heads/<name>` or `detached`.
fn speedy_worktrees(root: &Path, base: &Path) -> Result<Vec<(PathBuf, Option<String>)>, String> {
    let listing = git(root, &["worktree", "list", "--porcelain"]).map_err(|_| "This project isn't in a git repository")?;
    let base = real(base);
    Ok(listing
        .split("\n\n")
        .filter_map(|block| {
            let path = block.lines().find_map(|l| l.strip_prefix("worktree ")).map(PathBuf::from)?;
            let branch = block.lines().find_map(|l| l.strip_prefix("branch refs/heads/")).map(String::from);
            path.starts_with(&base).then_some((path, branch))
        })
        .collect())
}

/// Whether deleting `branch` loses no commits: the same test `git branch -d` makes (merged into
/// its upstream when it has one, else into the project's `HEAD`).
fn merged(root: &Path, branch: &str) -> bool {
    let upstream = format!("{branch}@{{upstream}}");
    let into = if git(root, &["rev-parse", "--verify", "--quiet", &upstream]).is_ok() { upstream.as_str() } else { "HEAD" };
    git(root, &["merge-base", "--is-ancestor", branch, into]).is_ok()
}

/// Speedy's worktrees of the repository (under `base`) that hold no path in `keep` (live
/// threads' working directories): what a cleanup would remove. Changes nothing.
pub fn unused(root: &Path, keep: &[String], base: &Path) -> Result<Vec<Unused>, String> {
    let keep: Vec<PathBuf> = keep.iter().map(|p| real(Path::new(p))).collect();
    Ok(speedy_worktrees(root, base)?
        .into_iter()
        .filter(|(path, _)| !keep.iter().any(|k| k.starts_with(path)))
        .map(|(path, branch)| Unused {
            dirty: git(&path, &["status", "--porcelain"]).map_or(true, |s| !s.is_empty()),
            merged: branch.as_deref().is_some_and(|b| merged(root, b)),
            path: path.to_string_lossy().into_owned(),
            branch,
        })
        .collect())
}

/// Removes the listed worktrees, but only Speedy's own (under `base`). Git refuses dirty ones;
/// those are reported, not forced. A removed worktree's branch is deleted only when it's merged
/// (`git branch -d`), so no commits are lost.
pub fn clean(root: &Path, paths: &[String], base: &Path) -> Result<CleanReport, String> {
    let wanted: Vec<PathBuf> = paths.iter().map(|p| real(Path::new(p))).collect();
    let mut report = CleanReport::default();
    for (path, branch) in speedy_worktrees(root, base)? {
        if !wanted.contains(&path) {
            continue;
        }
        let shown = path.to_string_lossy().into_owned();
        if let Err(reason) = git(root, &["worktree", "remove", &shown]) {
            report.skipped.push(Skipped { path: shown, reason });
            continue;
        }
        report.removed.push(shown);
        if let Some(branch) = branch
            && git(root, &["branch", "-d", &branch]).is_ok()
        {
            report.deleted_branches.push(branch);
        }
    }
    // Drops records of worktrees whose folders were deleted by hand.
    let _ = git(root, &["worktree", "prune"]);
    Ok(report)
}

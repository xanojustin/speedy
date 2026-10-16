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

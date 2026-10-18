//! U9: gitignore-aware fuzzy file search for @-mentions.
//!
//! Walks the project with the `ignore` crate (the walker ripgrep uses), so `.gitignore`,
//! `.git/info/exclude` and the global git excludes apply when the extension's
//! `claudeCode.respectGitIgnore` is on. `.ignore` files always apply, matching that setting's
//! description. `.git` itself is never listed. Paths are ranked with `nucleo-matcher`'s path
//! scoring (the matcher behind Helix's file picker).

use std::cmp::Reverse;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use ignore::{WalkBuilder, WalkState};
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

/// Stop walking after this many entries so a keystroke never stalls on a huge tree.
pub const MAX_ENTRIES: usize = 50_000;
pub const DEFAULT_LIMIT: usize = 50;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// Path relative to the project root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
}

pub async fn files_search(
    root: String,
    query: String,
    limit: Option<usize>,
    respect_gitignore: Option<bool>,
) -> Result<Vec<FileHit>, String> {
    // The walk is blocking IO; keep it off the async runtime's worker threads.
    tokio::task::spawn_blocking(move || {
        search(Path::new(&root), &query, limit.unwrap_or(DEFAULT_LIMIT), respect_gitignore.unwrap_or(true))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Entries under `root` (files and directories), best matches for `query` first, at most `limit`.
/// An empty query lists the shallowest, shortest paths first.
pub fn search(root: &Path, query: &str, limit: usize, respect_gitignore: bool) -> Vec<FileHit> {
    let entries = walk(root, respect_gitignore);
    let query = query.trim();

    if query.is_empty() {
        let mut all = entries;
        all.sort_by(|a, b| {
            let depth = |h: &FileHit| h.path.matches('/').count();
            (depth(a), a.path.len(), &a.path).cmp(&(depth(b), b.path.len(), &b.path))
        });
        all.truncate(limit);
        return all;
    }

    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::new(query, CaseMatching::Smart, Normalization::Smart, AtomKind::Fuzzy);
    let mut buf = Vec::new();
    let mut scored: Vec<(u32, FileHit)> = entries
        .into_iter()
        .filter_map(|hit| {
            let score = pattern.score(Utf32Str::new(&hit.path, &mut buf), &mut matcher)?;
            Some((score, hit))
        })
        .collect();
    scored.sort_by(|(sa, a), (sb, b)| (Reverse(*sa), a.path.len(), &a.path).cmp(&(Reverse(*sb), b.path.len(), &b.path)));
    scored.into_iter().take(limit).map(|(_, hit)| hit).collect()
}

fn walk(root: &Path, respect_gitignore: bool) -> Vec<FileHit> {
    let out = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);
    builder(root, respect_gitignore).build_parallel().run(|| {
        Box::new(|entry| {
            let Ok(entry) = entry else { return WalkState::Continue };
            if entry.depth() == 0 {
                return WalkState::Continue;
            }
            if count.fetch_add(1, Ordering::Relaxed) >= MAX_ENTRIES {
                return WalkState::Quit;
            }
            let Ok(rel) = entry.path().strip_prefix(root) else { return WalkState::Continue };
            let path = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            out.lock().unwrap_or_else(|e| e.into_inner()).push(FileHit { path, is_dir });
            WalkState::Continue
        })
    });
    out.into_inner().unwrap_or_else(|e| e.into_inner())
}

fn builder(root: &Path, respect_gitignore: bool) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(false)
        .parents(true)
        .ignore(true)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git");
    b
}

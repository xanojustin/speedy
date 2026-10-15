//! U9: @-mention file search (gitignore-aware walk + fuzzy ranking).

use std::fs;
use std::path::Path;

use speedy_lib::files::{search, FileHit};

fn write(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    write(r, ".gitignore", "node_modules/\nbuild/\n*.log\n");
    write(r, ".git/config", "[core]\n");
    write(r, ".git/HEAD", "ref: refs/heads/main\n");
    write(r, "src/main.rs", "fn main() {}\n");
    write(r, "src/lib.rs", "");
    write(r, "src/util/mod.rs", "");
    write(r, "docs/maintenance.md", "");
    write(r, "README.md", "");
    write(r, "debug.log", "");
    write(r, "build/out.js", "");
    write(r, "node_modules/pkg/main.js", "");
    write(r, "node_modules/pkg/index.js", "");
    dir
}

fn paths(hits: &[FileHit]) -> Vec<&str> {
    hits.iter().map(|h| h.path.as_str()).collect()
}

#[test]
fn src_ma_ranks_src_main_rs_first_and_skips_ignored_paths() {
    let dir = project();
    let hits = search(dir.path(), "src/ma", 50, true);
    let p = paths(&hits);
    assert_eq!(p.first(), Some(&"src/main.rs"), "got {p:?}");
    assert!(p.iter().all(|x| !x.starts_with("node_modules")), "node_modules leaked: {p:?}");
    assert!(p.iter().all(|x| !x.starts_with("build")), "gitignored build/ leaked: {p:?}");
    assert!(p.iter().all(|x| !x.starts_with(".git/") && *x != ".git"), ".git leaked: {p:?}");
}

#[test]
fn gitignored_files_never_match_when_respecting_gitignore() {
    let dir = project();
    let p: Vec<String> = search(dir.path(), "", 1000, true).into_iter().map(|h| h.path).collect();
    for ignored in ["debug.log", "build", "build/out.js", "node_modules", "node_modules/pkg/index.js", ".git", ".git/config"] {
        assert!(!p.iter().any(|x| x == ignored), "{ignored} should be excluded: {p:?}");
    }
    assert!(p.iter().any(|x| x == "src/main.rs"));
    assert!(p.iter().any(|x| x == ".gitignore"), "dotfiles that aren't ignored are listed: {p:?}");
}

#[test]
fn without_respect_gitignore_ignored_files_appear_but_git_dir_never_does() {
    let dir = project();
    let all: Vec<String> = search(dir.path(), "", 1000, false).into_iter().map(|h| h.path).collect();
    assert!(all.iter().any(|x| x == "build/out.js"), "{all:?}");
    assert!(all.iter().any(|x| x == "node_modules/pkg/index.js"), "{all:?}");
    assert!(all.iter().any(|x| x == "debug.log"), "{all:?}");
    assert!(all.iter().all(|x| x != ".git" && !x.starts_with(".git/")), "{all:?}");

    let hits = search(dir.path(), "out.js", 50, false);
    assert_eq!(paths(&hits).first(), Some(&"build/out.js"));
}

#[test]
fn directories_are_included_and_flagged() {
    let dir = project();
    let hits = search(dir.path(), "util", 50, true);
    let util = hits.iter().find(|h| h.path == "src/util").expect("src/util listed");
    assert!(util.is_dir);
    let main = search(dir.path(), "main.rs", 50, true);
    assert!(!main.iter().find(|h| h.path == "src/main.rs").unwrap().is_dir);
}

#[test]
fn empty_query_lists_shallow_short_paths_first_and_honors_limit() {
    let dir = project();
    let hits = search(dir.path(), "", 4, true);
    assert_eq!(hits.len(), 4);
    assert!(hits.iter().all(|h| !h.path.contains('/')), "top-level entries first: {:?}", paths(&hits));
}

#[test]
fn limit_caps_ranked_results() {
    let dir = project();
    assert_eq!(search(dir.path(), "s", 2, true).len(), 2);
}

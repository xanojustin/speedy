use std::fs;
use std::path::Path;
use std::process::Command;

use speedy_core::worktree::{clean, create, unused};

fn put(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("myrepo");
    put(&repo, "app/a.md", "a\n");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    dir
}

#[test]
fn creates_a_new_branch_in_its_own_worktree_and_keeps_the_project_prefix() {
    let dir = repo();
    let repo = dir.path().join("myrepo");
    let base = dir.path().join("worktrees");

    let wt = create(&repo.join("app"), "justin/DEV-1/thing", &base).unwrap();
    assert_eq!(wt.branch, "justin/DEV-1/thing");
    let expected = base.join("myrepo/justin-DEV-1-thing/app");
    assert_eq!(Path::new(&wt.path), expected);
    assert_eq!(fs::read_to_string(expected.join("a.md")).unwrap(), "a\n");
    assert_eq!(git(&expected, &["symbolic-ref", "--short", "HEAD"]), "justin/DEV-1/thing");
    // The project's own checkout is untouched.
    assert_eq!(git(&repo, &["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(git(&repo, &["status", "--porcelain"]), "");
}

#[test]
fn checks_out_an_existing_branch_and_picks_a_free_folder() {
    let dir = repo();
    let repo = dir.path().join("myrepo");
    let base = dir.path().join("worktrees");
    git(&repo, &["branch", "feature"]);
    fs::create_dir_all(base.join("myrepo/feature")).unwrap();

    let wt = create(&repo, "feature", &base).unwrap();
    assert_eq!(Path::new(&wt.path), base.join("myrepo/feature-2"));
    assert_eq!(git(Path::new(&wt.path), &["symbolic-ref", "--short", "HEAD"]), "feature");
}

#[test]
fn reports_git_errors_and_bad_names() {
    let dir = repo();
    let repo = dir.path().join("myrepo");
    let base = dir.path().join("worktrees");

    assert!(create(&repo, "bad..name", &base).unwrap_err().contains("isn't a valid branch name"));
    assert_eq!(create(&repo, "  ", &base).unwrap_err(), "Enter a branch name");
    // `main` is already checked out in the project folder; git's own reason comes back.
    assert!(create(&repo, "main", &base).unwrap_err().contains("main"));

    let plain = tempfile::tempdir().unwrap();
    assert_eq!(create(plain.path(), "x", &base).unwrap_err(), "This project isn't in a git repository");
}

#[test]
fn lists_unused_speedy_worktrees_then_removes_only_the_confirmed_ones() {
    let dir = repo();
    let repo = dir.path().join("myrepo");
    let base = dir.path().join("worktrees");
    let live = create(&repo.join("app"), "live", &base).unwrap();
    let done = create(&repo, "done", &base).unwrap();
    let unmerged = create(&repo, "unmerged", &base).unwrap();
    put(Path::new(&unmerged.path), "new.md", "new\n");
    git(Path::new(&unmerged.path), &["add", "."]);
    git(Path::new(&unmerged.path), &["commit", "-qm", "work"]);
    let dirty = create(&repo, "dirty", &base).unwrap();
    put(Path::new(&dirty.path), "wip.md", "wip\n");
    // A worktree the user made themselves, outside Speedy's folder.
    let own = dir.path().join("own");
    git(&repo, &["worktree", "add", "-q", "-b", "own", own.to_str().unwrap()]);

    let found = unused(&repo.join("app"), std::slice::from_ref(&live.path), &base).unwrap();
    let summary: Vec<_> = found.iter().map(|u| (u.branch.as_deref().unwrap(), u.dirty, u.merged)).collect();
    assert_eq!(summary, [("dirty", true, true), ("done", false, true), ("unmerged", false, false)]);
    // Listing changes nothing.
    assert!(Path::new(&done.path).exists());

    // The user confirms everything but the dirty one; the user's own worktree is never Speedy's to remove.
    let mut paths: Vec<String> = found.iter().filter(|u| !u.dirty).map(|u| u.path.clone()).collect();
    paths.push(own.to_string_lossy().into_owned());
    let report = clean(&repo, &paths, &base).unwrap();

    assert_eq!(report.removed.len(), 2);
    assert!(report.skipped.is_empty());
    assert!(!Path::new(&done.path).exists());
    assert!(!Path::new(&unmerged.path).exists());
    assert!(Path::new(&dirty.path).join("wip.md").exists());
    assert!(Path::new(&live.path).exists());
    assert!(own.exists());
    // Merged branches go; one with its own commits stays, so nothing is lost.
    assert_eq!(report.deleted_branches, ["done"]);
    let branches = git(&repo, &["branch", "--format=%(refname:short)"]);
    assert_eq!(branches.lines().collect::<Vec<_>>(), ["dirty", "live", "main", "own", "unmerged"]);
}

#[test]
fn clean_reports_worktrees_git_refuses_to_remove() {
    let dir = repo();
    let repo = dir.path().join("myrepo");
    let base = dir.path().join("worktrees");
    let wt = create(&repo, "late", &base).unwrap();
    // Changed after the preview.
    put(Path::new(&wt.path), "late.md", "late\n");

    let report = clean(&repo, std::slice::from_ref(&wt.path), &base).unwrap();
    assert!(report.removed.is_empty());
    assert_eq!(report.skipped.len(), 1);
    assert!(Path::new(&wt.path).join("late.md").exists());
}

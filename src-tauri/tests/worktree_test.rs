use std::fs;
use std::path::Path;
use std::process::Command;

use speedy_lib::worktree::create;

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

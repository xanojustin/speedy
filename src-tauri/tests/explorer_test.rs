//! File explorer: listing, path confinement, saving, and git status/diff.

use std::fs;
use std::path::Path;
use std::process::Command;

use speedy_lib::explorer::{git_branch, git_diff, git_status, list, read, resolve, write};

fn put(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}

fn git(root: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

#[test]
fn lists_one_level_folders_first_skipping_git_and_flagging_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    put(r, ".gitignore", "node_modules/\n.env\n");
    put(r, ".git/HEAD", "ref: refs/heads/main\n");
    put(r, ".env", "SECRET=1\n");
    put(r, "b.md", "");
    put(r, "A.md", "");
    put(r, "src/main.rs", "");
    put(r, "node_modules/x.js", "");

    let names: Vec<_> = list(r, "").unwrap().into_iter().map(|e| (e.path, e.is_dir, e.ignored)).collect();
    assert_eq!(
        names,
        vec![
            ("node_modules".into(), true, true),
            ("src".into(), true, false),
            (".env".into(), false, true),
            (".gitignore".into(), false, false),
            ("A.md".into(), false, false),
            ("b.md".into(), false, false),
        ]
    );
    let sub: Vec<_> = list(r, "src").unwrap().into_iter().map(|e| (e.path, e.ignored)).collect();
    assert_eq!(sub, vec![("src/main.rs".into(), false)]);
    let inside: Vec<_> = list(r, "node_modules").unwrap().into_iter().map(|e| (e.path, e.ignored)).collect();
    assert_eq!(inside, vec![("node_modules/x.js".into(), true)]);
}

#[test]
fn refuses_paths_outside_the_project() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("proj");
    put(&root, "a.md", "x");
    put(outer.path(), "secret.txt", "s");
    assert!(resolve(&root, "../secret.txt").is_err());
    assert!(resolve(&root, outer.path().join("secret.txt").to_str().unwrap()).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outer.path().join("secret.txt"), root.join("link.txt")).unwrap();
        assert!(read(&root, "link.txt").is_err());
        assert!(write(&root, "link.txt", "pwned").is_err());
        assert_eq!(fs::read_to_string(outer.path().join("secret.txt")).unwrap(), "s");
    }
}

#[test]
fn reads_and_saves_existing_text_files_only() {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    put(r, "notes.md", "# hi\n");
    fs::write(r.join("bin.dat"), [0xff, 0xfe, 0x00]).unwrap();
    assert_eq!(read(r, "notes.md").unwrap(), "# hi\n");
    assert!(read(r, "bin.dat").is_err());
    write(r, "notes.md", "# bye\n").unwrap();
    assert_eq!(fs::read_to_string(r.join("notes.md")).unwrap(), "# bye\n");
    assert!(write(r, "new.md", "x").is_err());
}

#[test]
fn git_status_and_diff_are_relative_to_a_subfolder_project() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    put(repo, "docs/a.md", "one\ntwo\n");
    put(repo, "other.md", "x\n");
    git(repo, &["init", "-q"]);
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "init"]);
    put(repo, "docs/a.md", "one\nTWO\n");
    put(repo, "docs/new.md", "fresh\n");
    put(repo, "other.md", "y\n");

    let docs = repo.join("docs");
    let mut changes: Vec<_> = git_status(&docs).into_iter().map(|c| (c.path, c.status)).collect();
    changes.sort();
    assert_eq!(changes, vec![("a.md".into(), "M".into()), ("new.md".into(), "U".into())]);

    let d = git_diff(&docs, "a.md").unwrap();
    assert!(!d.is_new_file);
    assert!(d.unified.contains("-two\n+TWO\n"), "{}", d.unified);
    let n = git_diff(&docs, "new.md").unwrap();
    assert!(n.is_new_file);
    assert!(n.unified.contains("+fresh"));
}

#[test]
fn no_git_status_outside_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "a.md", "");
    assert!(git_status(dir.path()).is_empty());
}

#[test]
fn git_branch_names_the_branch_or_detached_commit() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    assert_eq!(git_branch(repo), None);

    git(repo, &["init", "-q", "-b", "main"]);
    assert_eq!(git_branch(repo).as_deref(), Some("main"), "unborn branch");

    put(repo, "sub/a.md", "a\n");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "init"]);
    git(repo, &["checkout", "-qb", "justin/DEV-1/thing"]);
    assert_eq!(git_branch(&repo.join("sub")).as_deref(), Some("justin/DEV-1/thing"));

    git(repo, &["checkout", "-q", "--detach"]);
    let detached = git_branch(repo).unwrap();
    assert!(detached.chars().all(|c| c.is_ascii_hexdigit()), "{detached}");
}

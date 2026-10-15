//! U10 (Rust part): diffs for Edit/Write/MultiEdit permission requests (KTD5).

use serde_json::json;
use speedy_lib::claude::diff::{diff_for_tool, refresh_if_stale};

fn changed_lines(unified: &str) -> Vec<&str> {
    unified
        .lines()
        .filter(|l| (l.starts_with('-') && !l.starts_with("---")) || (l.starts_with('+') && !l.starts_with("+++")))
        .collect()
}

#[test]
fn edit_with_existing_old_string_shows_exactly_that_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let body: String = (1..=20).map(|i| format!("line {i}\n")).collect();
    std::fs::write(dir.path().join("a.txt"), &body).unwrap();

    let diffs = diff_for_tool(
        "Edit",
        &json!({"file_path": "a.txt", "old_string": "line 10\n", "new_string": "line ten\n"}),
        dir.path(),
    )
    .expect("Edit yields a diff");

    assert_eq!(diffs.len(), 1);
    let d = &diffs[0];
    assert!(!d.is_new_file);
    assert_eq!(d.path, dir.path().join("a.txt").to_string_lossy());
    assert_eq!(changed_lines(&d.unified), vec!["-line 10", "+line ten"]);
    assert!(d.unified.contains("--- ") && d.unified.contains("+++ ") && d.unified.contains("@@"));
    // Three lines of context on either side.
    assert!(d.unified.contains(" line 7\n") && d.unified.contains(" line 13\n"));
    assert!(!d.unified.contains(" line 6\n") && !d.unified.contains(" line 14\n"));
}

#[test]
fn edit_replace_all_and_multiedit_apply_every_change() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("b.txt");
    std::fs::write(&file, "x\ny\nx\n").unwrap();

    let all = diff_for_tool(
        "Edit",
        &json!({"file_path": file, "old_string": "x", "new_string": "z", "replace_all": true}),
        dir.path(),
    )
    .unwrap();
    assert_eq!(changed_lines(&all[0].unified).iter().filter(|l| l.starts_with('+')).count(), 2);

    let multi = diff_for_tool(
        "MultiEdit",
        &json!({"file_path": file, "edits": [
            {"old_string": "x\ny", "new_string": "x\nY"},
            {"old_string": "Y\nx", "new_string": "Y\nQ"}
        ]}),
        dir.path(),
    )
    .unwrap();
    assert_eq!(changed_lines(&multi[0].unified), vec!["-y", "-x", "+Y", "+Q"]);
}

#[test]
fn write_to_new_file_is_all_additions_and_marked_new() {
    let dir = tempfile::tempdir().unwrap();
    let diffs = diff_for_tool("Write", &json!({"file_path": "new/c.txt", "content": "one\ntwo\n"}), dir.path()).unwrap();
    let d = &diffs[0];
    assert!(d.is_new_file);
    assert_eq!(changed_lines(&d.unified), vec!["+one", "+two"]);
}

#[test]
fn write_over_existing_file_diffs_against_current_contents() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("d.txt"), "keep\nold\n").unwrap();
    let diffs = diff_for_tool("Write", &json!({"file_path": "d.txt", "content": "keep\nnew\nmore\n"}), dir.path()).unwrap();
    let d = &diffs[0];
    assert!(!d.is_new_file);
    assert_eq!(changed_lines(&d.unified), vec!["-old", "+new", "+more"]);
}

#[test]
fn other_tools_have_no_diff() {
    let dir = tempfile::tempdir().unwrap();
    assert!(diff_for_tool("Bash", &json!({"command": "ls"}), dir.path()).is_none());
}

#[test]
fn fingerprint_changes_when_the_file_changes_and_refresh_reports_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("e.txt");
    std::fs::write(&file, "hello\n").unwrap();
    let input = json!({"file_path": "e.txt", "old_string": "hello", "new_string": "bye"});

    let first = diff_for_tool("Edit", &input, dir.path()).unwrap();
    let again = diff_for_tool("Edit", &input, dir.path()).unwrap();
    assert_eq!(first[0].base_fingerprint, again[0].base_fingerprint);
    assert!(refresh_if_stale("Edit", &input, dir.path(), &first).is_none());

    std::fs::write(&file, "hello world\n").unwrap();
    let changed = diff_for_tool("Edit", &input, dir.path()).unwrap();
    assert_ne!(first[0].base_fingerprint, changed[0].base_fingerprint);
    let refreshed = refresh_if_stale("Edit", &input, dir.path(), &first).expect("stale diff is refreshed");
    assert_eq!(refreshed, changed);

    // An absent file has a fixed fingerprint distinct from any contents.
    let absent = diff_for_tool("Write", &json!({"file_path": "nope.txt", "content": ""}), dir.path()).unwrap();
    std::fs::write(dir.path().join("nope.txt"), "").unwrap();
    let empty = diff_for_tool("Write", &json!({"file_path": "nope.txt", "content": ""}), dir.path()).unwrap();
    assert_ne!(absent[0].base_fingerprint, empty[0].base_fingerprint);
}

#[test]
fn huge_files_are_summarized_and_pathological_replace_all_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.txt");
    std::fs::write(&big, "a\n".repeat(3 * 1024 * 1024)).unwrap();
    let input = serde_json::json!({"file_path": big.to_str().unwrap(), "content": "small\n"});
    let d = &speedy_lib::claude::diff::diff_for_tool("Write", &input, dir.path()).unwrap()[0];
    assert!(d.unified.contains("file too large to show a diff"), "{}", d.unified);

    // Under the read cap, so the replace_all expansion guard is what refuses it.
    let mid = dir.path().join("mid.txt");
    std::fs::write(&mid, "a\n".repeat(1024 * 1024)).unwrap();
    let blowup = serde_json::json!({
        "file_path": mid.to_str().unwrap(), "old_string": "a", "new_string": "x".repeat(100_000), "replace_all": true
    });
    assert!(speedy_lib::claude::diff::diff_for_tool("Edit", &blowup, dir.path()).is_none());
    let empty_old = serde_json::json!({"file_path": big.to_str().unwrap(), "old_string": "", "new_string": "x"});
    assert!(speedy_lib::claude::diff::diff_for_tool("Edit", &empty_old, dir.path()).is_none());
}

#[test]
fn staleness_fails_closed_when_the_change_cannot_be_rediffed() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("a.txt");
    std::fs::write(&f, "one\n").unwrap();
    let input = serde_json::json!({"file_path": f.to_str().unwrap(), "old_string": "one", "new_string": "two"});
    let shown = speedy_lib::claude::diff::diff_for_tool("Edit", &input, dir.path()).unwrap();
    // Another writer changes the file; the stored input no longer yields a diff.
    std::fs::write(&f, "changed\n").unwrap();
    let bad_input = serde_json::json!({"file_path": f.to_str().unwrap(), "old_string": "", "new_string": "x"});
    let refreshed = speedy_lib::claude::diff::refresh_if_stale("Edit", &bad_input, dir.path(), &shown);
    assert_eq!(refreshed, Some(vec![]), "a changed file must block the allow even without a new diff");
}

/// Runs `f` on a helper thread, failing (instead of hanging) if it doesn't return promptly.
fn within_5s<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_else(|_| panic!("{what} did not return promptly"))
}

/// Review #4: a FIFO is never opened for reading (that would block forever).
#[test]
fn fifo_target_returns_promptly_with_a_summary() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("pipe");
    assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
    let path = fifo.to_str().unwrap().to_owned();
    let p = path.clone();
    let cwd = dir.path().to_path_buf();
    let diffs = within_5s("diff_for_tool on a FIFO", move || {
        diff_for_tool("Write", &json!({"file_path": p, "content": "x\n"}), &cwd)
    })
    .expect("Write yields a summary");
    let d = &diffs[0];
    assert!(!d.is_new_file);
    assert!(d.unified.contains("not a regular file"), "{}", d.unified);
    assert_ne!(d.base_fingerprint, "absent");

    let shown = diffs.clone();
    let cwd = dir.path().to_path_buf();
    let stale = within_5s("refresh_if_stale on a FIFO", move || {
        refresh_if_stale("Write", &json!({"file_path": path, "content": "x\n"}), &cwd, &shown)
    });
    assert!(stale.is_none(), "an unchanged FIFO is not stale");
}

/// Review #4: a device that never ends is not read to EOF.
#[test]
fn dev_zero_target_returns_promptly_with_a_summary() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_path_buf();
    let diffs = within_5s("diff_for_tool on /dev/zero", move || {
        diff_for_tool("Edit", &json!({"file_path": "/dev/zero", "old_string": "a", "new_string": "b"}), &cwd)
    })
    .expect("Edit yields a summary");
    assert!(diffs[0].unified.contains("not a regular file"), "{}", diffs[0].unified);
    let shown = diffs.clone();
    let cwd = dir.path().to_path_buf();
    within_5s("refresh_if_stale on /dev/zero", move || {
        refresh_if_stale("Edit", &json!({"file_path": "/dev/zero", "old_string": "a", "new_string": "b"}), &cwd, &shown)
    });
}

/// Review #4: an over-cap regular file is summarized from its metadata, for Edit
/// as well as Write, and its fingerprint still tracks changes.
#[test]
fn over_cap_file_is_summarized_and_its_fingerprint_tracks_changes() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.bin");
    std::fs::write(&big, vec![b'q'; 5 * 1024 * 1024]).unwrap();
    let edit = json!({"file_path": "big.bin", "old_string": "q", "new_string": "r"});

    let shown = diff_for_tool("Edit", &edit, dir.path()).expect("Edit on a huge file yields a summary");
    assert!(!shown[0].is_new_file);
    assert!(shown[0].unified.contains("file too large to show a diff"), "{}", shown[0].unified);
    let write = diff_for_tool("Write", &json!({"file_path": "big.bin", "content": "s\n"}), dir.path()).unwrap();
    assert!(write[0].unified.contains("file too large to show a diff"), "{}", write[0].unified);
    assert_eq!(write[0].base_fingerprint, shown[0].base_fingerprint);
    assert!(refresh_if_stale("Edit", &edit, dir.path(), &shown).is_none());

    std::fs::write(&big, vec![b'q'; 5 * 1024 * 1024 + 1]).unwrap();
    let refreshed = refresh_if_stale("Edit", &edit, dir.path(), &shown).expect("a changed huge file is stale");
    assert_ne!(refreshed[0].base_fingerprint, shown[0].base_fingerprint);

    // Shrinking under the cap switches back to a real diff, and that is a change too.
    std::fs::write(&big, "q\n").unwrap();
    let small = refresh_if_stale("Edit", &edit, dir.path(), &refreshed).expect("shrunk file is stale");
    assert!(small[0].unified.contains("-q") && small[0].unified.contains("+r"), "{}", small[0].unified);
}

/// Review #4: an empty old_string is still refused when the base can't be read.
#[test]
fn malformed_edit_on_an_unreadable_base_still_has_no_diff() {
    let dir = tempfile::tempdir().unwrap();
    let input = json!({"file_path": "/dev/zero", "old_string": "", "new_string": "x"});
    assert!(within_5s("malformed Edit on /dev/zero", move || diff_for_tool("Edit", &input, dir.path()).is_none()));
}

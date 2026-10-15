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

    let blowup = serde_json::json!({
        "file_path": big.to_str().unwrap(), "old_string": "a", "new_string": "x".repeat(100_000), "replace_all": true
    });
    assert!(speedy_lib::claude::diff::diff_for_tool("Edit", &blowup, dir.path()).is_none());
    let empty_old = serde_json::json!({"file_path": big.to_str().unwrap(), "old_string": "", "new_string": "x"});
    assert!(speedy_lib::claude::diff::diff_for_tool("Edit", &empty_old, dir.path()).is_none());
}

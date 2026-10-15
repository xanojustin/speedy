//! U5: app state store and the CLI session index. All session files are synthetic.

use std::path::Path;
use std::time::{Duration, SystemTime};

use speedy_lib::state::session_index::{
    encode_project_dir, list_sessions, load_session, rename_session_offline,
};
use speedy_lib::state::store::STATE_VERSION;
use speedy_lib::state::{paths_exist, AppState, Project, StateStore, Thread};

fn sample_state() -> AppState {
    let projects = (0..2)
        .map(|p| Project {
            id: format!("p{p}"),
            path: format!("/Users/x/proj{p}"),
            name: format!("proj{p}"),
            collapsed: p == 1,
            threads: (0..3)
                .map(|t| Thread {
                    id: format!("p{p}t{t}"),
                    title: format!("thread {t}"),
                    session_id: Some(format!("sess-{p}-{t}")),
                    created_at: 1_000 + t,
                    split_ratio: 0.5,
                    ..Thread::default()
                })
                .collect(),
        })
        .collect();
    AppState { projects, selected_thread_id: Some("p1t2".into()), ..AppState::default() }
}

#[test]
fn saved_tree_reloads_with_same_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = StateStore::new(dir.path().to_path_buf());
    store.save(sample_state());
    store.flush();
    drop(store);

    let loaded = StateStore::new(dir.path().to_path_buf()).load();
    assert_eq!(loaded.notice, None);
    assert_eq!(loaded.state, sample_state());
    let ids: Vec<_> = loaded.state.projects.iter().flat_map(|p| p.threads.iter().map(|t| t.id.clone())).collect();
    assert_eq!(ids, ["p0t0", "p0t1", "p0t2", "p1t0", "p1t1", "p1t2"]);
}

#[test]
fn debounced_save_lands_without_flush() {
    let dir = tempfile::tempdir().unwrap();
    let store = StateStore::new(dir.path().to_path_buf());
    let mut first = sample_state();
    first.sidebar_width = 100.0;
    store.save(first);
    store.save(sample_state());
    std::thread::sleep(Duration::from_millis(1000));
    let loaded = StateStore::new(dir.path().to_path_buf()).load();
    assert_eq!(loaded.state, sample_state());
}

#[test]
fn crash_mid_write_leaves_previous_state_intact() {
    let dir = tempfile::tempdir().unwrap();
    let store = StateStore::new(dir.path().to_path_buf());
    store.save(sample_state());
    store.flush();
    drop(store);
    // A write that died before its rename: a partial temp file next to the real one.
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        assert!(!entry.unwrap().file_name().to_string_lossy().contains("tmp"), "temp file left behind");
    }
    std::fs::write(dir.path().join("state.json.tmp"), br#"{"version":1,"projects":[{"id":"#).unwrap();

    let store = StateStore::new(dir.path().to_path_buf());
    let loaded = store.load();
    assert_eq!(loaded.notice, None);
    assert_eq!(loaded.state, sample_state());
    // The next save still works and replaces the leftover.
    let mut next = sample_state();
    next.sidebar_width = 300.0;
    store.save(next.clone());
    store.flush();
    assert_eq!(StateStore::new(dir.path().to_path_buf()).load().state, next);
}

#[test]
fn older_schema_loads_with_defaults_for_new_fields() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("state.json"),
        r#"{"version":0,"projects":[{"id":"p","path":"/x","name":"x","threads":[{"id":"t","title":"old"}]}]}"#,
    )
    .unwrap();
    let loaded = StateStore::new(dir.path().to_path_buf()).load();
    assert_eq!(loaded.notice, None);
    let s = loaded.state;
    assert_eq!(s.version, STATE_VERSION);
    assert_eq!(s.sidebar_width, 260.0);
    let t = &s.projects[0].threads[0];
    assert_eq!(t.title, "old");
    assert_eq!(t.split_ratio, 0.65);
    assert!(t.terminal_visible);
    assert_eq!(t.session_id, None);
}

#[test]
fn corrupt_state_is_moved_aside_and_starts_empty_with_notice() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("state.json"), "{ not json").unwrap();
    let loaded = StateStore::new(dir.path().to_path_buf()).load();
    assert_eq!(loaded.state, AppState::default());
    assert!(!dir.path().join("state.json").exists());
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("state.json.corrupt-"))
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), "{ not json");
    let notice = loaded.notice.expect("notice");
    assert!(notice.contains(&backups[0].to_string_lossy().into_owned()), "{notice}");
}

#[test]
fn paths_exist_reports_missing_folder_as_false() {
    let dir = tempfile::tempdir().unwrap();
    let present = dir.path().to_string_lossy().into_owned();
    let missing = dir.path().join("gone").to_string_lossy().into_owned();
    assert_eq!(paths_exist(vec![present, missing]), vec![true, false]);
}

// ---- session index ----

fn user_line(session: &str, ts: &str, text: &str) -> String {
    serde_json::json!({
        "parentUuid": null, "isSidechain": false, "type": "user",
        "message": {"role": "user", "content": text},
        "uuid": "u1", "timestamp": ts, "cwd": "/whatever", "sessionId": session
    })
    .to_string()
}

fn write_session(dir: &Path, id: &str, lines: &[String], mtime_secs: u64) {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("{id}.jsonl"));
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    let f = std::fs::File::options().write(true).open(&path).unwrap();
    f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(mtime_secs)).unwrap();
}

#[test]
fn encoding_replaces_every_non_alphanumeric_char() {
    assert_eq!(encode_project_dir("/Users/x/brecht/speedy"), "-Users-x-brecht-speedy");
    assert_eq!(encode_project_dir("/private/tmp/a/-B"), "-private-tmp-a--B");
    assert_eq!(encode_project_dir("/Users/x/My Project.v2"), "-Users-x-My-Project-v2");
}

#[test]
fn folder_with_spaces_and_dots_lists_sessions_newest_first() {
    let root = tempfile::tempdir().unwrap();
    let folder = "/Users/x/My Proj.app/v1.2";
    let dir = root.path().join("-Users-x-My-Proj-app-v1-2");
    write_session(&dir, "old", &[user_line("old", "2026-01-01T00:00:00.000Z", "first question")], 1_000);
    write_session(&dir, "new", &[user_line("new", "2026-02-01T00:00:00.000Z", "second question")], 2_000);

    let list = list_sessions(root.path(), folder).unwrap();
    let ids: Vec<_> = list.iter().map(|s| s.session_id.as_str()).collect();
    assert_eq!(ids, ["new", "old"]);
    assert_eq!(list[0].title, "second question");
    assert_eq!(list[0].modified_ms, 2_000_000);
    assert_eq!(list[1].created_ms, 1_767_225_600_000); // 2026-01-01T00:00:00Z
    assert_eq!(list[0].file_path, dir.join("new.jsonl").to_string_lossy());
}

#[test]
fn unknown_folder_lists_nothing() {
    let root = tempfile::tempdir().unwrap();
    assert!(list_sessions(root.path(), "/nowhere").unwrap().is_empty());
}

#[test]
fn truncated_dir_name_found_by_cwd_scan() {
    let root = tempfile::tempdir().unwrap();
    let folder = "/Users/x/some/very/long/folder";
    let dir = root.path().join("-Users-x-some-very-lo-abc123");
    let line = serde_json::json!({"type": "user", "cwd": folder, "sessionId": "s",
        "timestamp": "2026-01-01T00:00:00.000Z", "message": {"role": "user", "content": "hi there"}});
    write_session(&dir, "s", &[line.to_string()], 1_000);
    let list = list_sessions(root.path(), folder).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title, "hi there");
}

#[test]
fn unknown_line_types_are_skipped() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(encode_project_dir("/p"));
    write_session(
        &dir,
        "s",
        &[
            r#"{"type":"some-future-thing","weird":[1,2,3]}"#.to_string(),
            "this line is not json".to_string(),
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: meta"}}"#.to_string(),
            serde_json::json!({"type":"user","timestamp":"2026-01-01T00:00:00.000Z",
                "message":{"role":"user","content":[
                    {"type":"text","text":"<ide_opened_file>x.rs</ide_opened_file>"},
                    {"type":"text","text":"fix the parser\nplease"}]}})
            .to_string(),
        ],
        1_000,
    );
    let list = list_sessions(root.path(), "/p").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title, "fix the parser");
    assert_eq!(list[0].created_ms, 1_767_225_600_000);
}

#[test]
fn custom_title_beats_later_ai_title() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(encode_project_dir("/p"));
    write_session(
        &dir,
        "s",
        &[
            user_line("s", "2026-01-01T00:00:00.000Z", "hello"),
            r#"{"type":"ai-title","aiTitle":"Early AI title","sessionId":"s"}"#.into(),
            r#"{"type":"custom-title","customTitle":"My rename","sessionId":"s"}"#.into(),
            user_line("s", "2026-01-01T00:01:00.000Z", "more work"),
            r#"{"type":"ai-title","aiTitle":"Later AI title","sessionId":"s"}"#.into(),
        ],
        1_000,
    );
    assert_eq!(list_sessions(root.path(), "/p").unwrap()[0].title, "My rename");

    write_session(
        &dir,
        "s",
        &[user_line("s", "2026-01-01T00:00:00.000Z", "hello"), r#"{"type":"ai-title","aiTitle":"Only AI","sessionId":"s"}"#.into()],
        2_000,
    );
    assert_eq!(list_sessions(root.path(), "/p").unwrap()[0].title, "Only AI");
}

#[test]
fn offline_rename_appends_cli_format_line_and_relists() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(encode_project_dir("/p"));
    write_session(&dir, "abc", &[user_line("abc", "2026-01-01T00:00:00.000Z", "hello")], 1_000);
    assert_eq!(list_sessions(root.path(), "/p").unwrap()[0].title, "hello");

    rename_session_offline(root.path(), "/p", "abc", "Renamed \"quoted\"").unwrap();
    let text = std::fs::read_to_string(dir.join("abc.jsonl")).unwrap();
    assert_eq!(
        text.lines().last().unwrap(),
        r#"{"type":"custom-title","customTitle":"Renamed \"quoted\"","sessionId":"abc"}"#
    );
    assert_eq!(list_sessions(root.path(), "/p").unwrap()[0].title, "Renamed \"quoted\"");
}

#[test]
fn session_load_returns_parseable_lines_in_order() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(encode_project_dir("/p"));
    write_session(
        &dir,
        "s",
        &[r#"{"type":"a"}"#.into(), "garbage".into(), r#"{"type":"b"}"#.into()],
        1_000,
    );
    let lines = load_session(root.path(), "/p", "s").unwrap();
    let types: Vec<_> = lines.iter().map(|v| v["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["a", "b"]);

    let err = load_session(root.path(), "/p", "missing").unwrap_err();
    assert!(err.contains("missing"), "{err}");
}

#[test]
fn session_ids_with_path_characters_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(encode_project_dir("/p"));
    write_session(&dir, "s", &[r#"{"type":"a"}"#.into()], 1_000);
    std::fs::write(root.path().join("secret.jsonl"), "{\"type\":\"x\"}\n").unwrap();

    let err = load_session(root.path(), "/p", "../secret").unwrap_err();
    assert!(err.contains("invalid session id"), "{err}");
    assert!(rename_session_offline(root.path(), "/p", "../secret", "t").is_err());
    assert_eq!(std::fs::read_to_string(root.path().join("secret.jsonl")).unwrap(), "{\"type\":\"x\"}\n");
}

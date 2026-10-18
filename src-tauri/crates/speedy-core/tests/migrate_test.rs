//! U10: the pre-hosts `state.json` splits into `host.json` and `client.json` on first
//! launch without losing resume, worktrees or Chats (R18, KTD6).

use std::path::Path;

use speedy_core::host::migrate::{migrate_client, migrate_host, split_legacy};
use speedy_core::host::store::HostState;
use speedy_core::state::AppState;
use speedy_core::state::client::ClientState;

const HOST: &str = "this-mac";

/// Two groups, the Chats project, a grouped collapsed project with a worktree thread and an
/// archived thread, and an ungrouped project.
const LEGACY: &str = r#"{
  "version": 1,
  "groups": [
    {"id": "g-work", "name": "Work", "collapsed": false, "color": "blue"},
    {"id": "g-play", "name": "Play", "collapsed": true, "color": null}
  ],
  "projects": [
    {"id": "chats-1700", "path": "/Users/me/Library/Application Support/Speedy/Chats", "name": "No Project",
     "collapsed": false, "groupId": null, "scratch": true,
     "threads": [
       {"id": "t-chat", "title": "Quick question", "sessionId": "sess-chat", "archived": false, "createdAt": 10,
        "splitRatio": 0.65, "terminalVisible": false, "terminalMaximized": false,
        "model": null, "permissionMode": null, "worktree": null, "worktreeRequested": false}
     ]},
    {"id": "p-api", "path": "/Users/me/src/api", "name": "api", "collapsed": true, "groupId": "g-work", "scratch": false,
     "threads": [
       {"id": "t-wt", "title": "Fix login", "sessionId": "sess-wt", "archived": false, "createdAt": 20,
        "splitRatio": 0.4, "terminalVisible": true, "terminalMaximized": true,
        "model": "opus", "permissionMode": "acceptEdits",
        "worktree": {"path": "/Users/me/Library/Application Support/Speedy/worktrees/api-ab12/src", "branch": "speedy/t-wt"},
        "worktreeRequested": false},
       {"id": "t-old", "title": "Old work", "sessionId": "sess-old", "archived": true, "createdAt": 5,
        "splitRatio": 0.65, "terminalVisible": false, "terminalMaximized": false,
        "model": null, "permissionMode": "plan", "worktree": null, "worktreeRequested": true}
     ]},
    {"id": "p-web", "path": "/Users/me/src/web", "name": "web", "collapsed": false, "groupId": null, "scratch": false,
     "threads": []}
  ],
  "selectedThreadId": "t-wt",
  "claudePathOverride": "/opt/claude",
  "sidebarWidth": 312.5,
  "notificationsEnabled": false,
  "completionSound": "Glass",
  "activityPanelVisible": true
}"#;

fn legacy_dir(contents: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("state.json"), contents).unwrap();
    dir
}

fn read_host(dir: &Path) -> HostState {
    serde_json::from_slice(&std::fs::read(dir.join("host.json")).unwrap()).unwrap()
}

fn read_client(dir: &Path) -> ClientState {
    serde_json::from_slice(&std::fs::read(dir.join("client.json")).unwrap()).unwrap()
}

#[test]
fn split_keeps_every_host_field_and_client_pref() {
    let legacy: AppState = serde_json::from_str(LEGACY).unwrap();
    let (host, client) = split_legacy(legacy, HOST);

    assert_eq!(host.claude_path_override.as_deref(), Some("/opt/claude"));
    let ids: Vec<&str> = host.projects.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["chats-1700", "p-api", "p-web"]);

    let chats = &host.projects[0];
    assert!(chats.scratch);
    assert_eq!(chats.path, "/Users/me/Library/Application Support/Speedy/Chats");
    assert_eq!(chats.name, "No Project");
    assert_eq!(chats.threads[0].id, "t-chat");
    assert_eq!(chats.threads[0].session_id.as_deref(), Some("sess-chat"));

    let api = &host.projects[1];
    assert_eq!((api.path.as_str(), api.name.as_str(), api.scratch), ("/Users/me/src/api", "api", false));
    let wt = &api.threads[0];
    assert_eq!(wt.title, "Fix login");
    assert_eq!(wt.session_id.as_deref(), Some("sess-wt"));
    assert_eq!(wt.created_at, 20);
    assert_eq!(wt.model.as_deref(), Some("opus"));
    assert_eq!(wt.permission_mode.as_deref(), Some("acceptEdits"));
    let worktree = wt.worktree.as_ref().unwrap();
    assert_eq!(worktree.path, "/Users/me/Library/Application Support/Speedy/worktrees/api-ab12/src");
    assert_eq!(worktree.branch, "speedy/t-wt");
    assert!(wt.queue.is_empty() && wt.fork.is_none());
    let old = &api.threads[1];
    assert!(old.archived && old.worktree_requested);
    assert_eq!(old.session_id.as_deref(), Some("sess-old"));
    assert_eq!(old.permission_mode.as_deref(), Some("plan"));
    assert!(host.projects[2].threads.is_empty());

    let groups: Vec<(&str, &str, bool, Option<&str>)> =
        client.groups.iter().map(|g| (g.id.as_str(), g.name.as_str(), g.collapsed, g.color.as_deref())).collect();
    assert_eq!(groups, [("g-work", "Work", false, Some("blue")), ("g-play", "Play", true, None)]);
    let projects: Vec<(&str, &str, bool, Option<&str>)> = client
        .projects
        .iter()
        .map(|p| (p.host_id.as_str(), p.project_id.as_str(), p.collapsed, p.group_id.as_deref()))
        .collect();
    assert_eq!(
        projects,
        [(HOST, "chats-1700", false, None), (HOST, "p-api", true, Some("g-work")), (HOST, "p-web", false, None)]
    );
    let wt_layout = client.threads.iter().find(|t| t.thread_id == "t-wt").unwrap();
    assert_eq!((wt_layout.split_ratio, wt_layout.terminal_visible, wt_layout.terminal_maximized), (0.4, true, true));
    let chat_layout = client.threads.iter().find(|t| t.thread_id == "t-chat").unwrap();
    assert_eq!(chat_layout.split_ratio, 0.65);
    assert_eq!(client.selected_thread_id.as_deref(), Some("t-wt"));
    assert_eq!(client.sidebar_width, 312.5);
    assert!(!client.notifications_enabled);
    assert_eq!(client.completion_sound.as_deref(), Some("Glass"));
    assert!(client.activity_panel_visible);
}

#[test]
fn client_defaults_match_the_legacy_defaults() {
    let client: ClientState = serde_json::from_str("{}").unwrap();
    let legacy = AppState::default();
    assert_eq!(client.sidebar_width, legacy.sidebar_width);
    assert_eq!(client.notifications_enabled, legacy.notifications_enabled);
    assert_eq!(client.activity_panel_visible, legacy.activity_panel_visible);
    assert_eq!(client.completion_sound, legacy.completion_sound);
}

#[test]
fn migrates_both_halves_to_disk_and_leaves_state_json_untouched() {
    let legacy = legacy_dir(LEGACY);
    let host_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();

    assert_eq!(migrate_host(legacy.path(), host_dir.path()), None);
    assert_eq!(migrate_client(legacy.path(), client_dir.path(), HOST), None);

    let expected: AppState = serde_json::from_str(LEGACY).unwrap();
    let (host, client) = split_legacy(expected, HOST);
    assert_eq!(read_host(host_dir.path()), host);
    assert_eq!(read_client(client_dir.path()), client);
    assert!(host_dir.path().join("migrated-from-state-json").exists());
    assert!(client_dir.path().join("client-migrated-from-state-json").exists());
    assert_eq!(std::fs::read_to_string(legacy.path().join("state.json")).unwrap(), LEGACY);
}

#[test]
fn second_run_does_nothing() {
    let legacy = legacy_dir(LEGACY);
    let host_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();
    migrate_host(legacy.path(), host_dir.path());
    migrate_client(legacy.path(), client_dir.path(), HOST);

    // Something else rewrote the files since; even with them gone, the markers stop a rerun.
    std::fs::write(host_dir.path().join("host.json"), r#"{"projects":[]}"#).unwrap();
    std::fs::remove_file(client_dir.path().join("client.json")).unwrap();

    assert_eq!(migrate_host(legacy.path(), host_dir.path()), None);
    assert_eq!(migrate_client(legacy.path(), client_dir.path(), HOST), None);
    assert_eq!(std::fs::read_to_string(host_dir.path().join("host.json")).unwrap(), r#"{"projects":[]}"#);
    assert!(!client_dir.path().join("client.json").exists());
}

#[test]
fn corrupt_state_json_gives_empty_files_and_a_notice_and_is_preserved() {
    let garbage = "{\"projects\": [ not json";
    let legacy = legacy_dir(garbage);
    let host_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();

    let host_notice = migrate_host(legacy.path(), host_dir.path());
    let client_notice = migrate_client(legacy.path(), client_dir.path(), HOST);

    assert!(host_notice.unwrap().contains("state.json"));
    assert!(client_notice.unwrap().contains("state.json"));
    assert_eq!(read_host(host_dir.path()), HostState::default());
    assert_eq!(read_client(client_dir.path()), ClientState::default());
    assert!(host_dir.path().join("migrated-from-state-json").exists());
    assert!(client_dir.path().join("client-migrated-from-state-json").exists());
    assert_eq!(std::fs::read_to_string(legacy.path().join("state.json")).unwrap(), garbage);
    let names: Vec<_> = std::fs::read_dir(legacy.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["state.json"]);
}

#[test]
fn existing_files_are_not_migrated_over() {
    let legacy = legacy_dir(LEGACY);
    let host_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();
    std::fs::write(host_dir.path().join("host.json"), "{}").unwrap();
    std::fs::write(client_dir.path().join("client.json"), "{}").unwrap();

    assert_eq!(migrate_host(legacy.path(), host_dir.path()), None);
    assert_eq!(migrate_client(legacy.path(), client_dir.path(), HOST), None);
    assert_eq!(std::fs::read_to_string(host_dir.path().join("host.json")).unwrap(), "{}");
    assert_eq!(std::fs::read_to_string(client_dir.path().join("client.json")).unwrap(), "{}");
    assert!(!host_dir.path().join("migrated-from-state-json").exists());
    assert!(!client_dir.path().join("client-migrated-from-state-json").exists());
}

#[test]
fn missing_state_json_is_a_no_op() {
    let legacy = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();

    assert_eq!(migrate_host(legacy.path(), host_dir.path()), None);
    assert_eq!(migrate_client(legacy.path(), client_dir.path(), HOST), None);
    assert_eq!(std::fs::read_dir(host_dir.path()).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(client_dir.path()).unwrap().count(), 0);
}

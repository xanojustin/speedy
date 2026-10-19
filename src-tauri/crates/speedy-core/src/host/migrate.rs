//! U10: moves the pre-hosts `state.json` into `host.json` (host fields) and `client.json`
//! (client fields) on first launch (KTD6, R18).
//!
//! Each half runs once: it skips when its target file or its marker already exists, and
//! when there is no `state.json` (a fresh install, which needs no marker since the first
//! save creates the target file). `state.json` is never modified or moved; a corrupt one
//! migrates as empty with a notice.

use std::path::Path;

use super::store::{HostProject, HostState, HostThread};
use crate::state::client::{ClientProject, ClientState, ClientThread};
use crate::state::store::{AppState, JsonStore, StoredState};

const HOST_MARKER: &str = "migrated-from-state-json";
const CLIENT_MARKER: &str = "client-migrated-from-state-json";

/// Splits the legacy state into the host's half and the client's half, keying the
/// client's project prefs by `host_id`.
pub fn split_legacy(legacy: AppState, host_id: &str) -> (HostState, ClientState) {
    let mut client_projects = Vec::with_capacity(legacy.projects.len());
    let mut client_threads = Vec::new();
    let mut host_projects = Vec::with_capacity(legacy.projects.len());
    for p in legacy.projects {
        client_projects.push(ClientProject {
            host_id: host_id.to_owned(),
            project_id: p.id.clone(),
            collapsed: p.collapsed,
            group_id: p.group_id,
        });
        let threads = p
            .threads
            .into_iter()
            .map(|t| {
                client_threads.push(ClientThread {
                    thread_id: t.id.clone(),
                    split_ratio: t.split_ratio,
                    terminal_visible: t.terminal_visible,
                    terminal_maximized: t.terminal_maximized,
                    explorer_visible: false,
                });
                HostThread {
                    id: t.id,
                    title: t.title,
                    session_id: t.session_id,
                    archived: t.archived,
                    created_at: t.created_at,
                    model: t.model,
                    permission_mode: t.permission_mode,
                    worktree: t.worktree,
                    worktree_requested: t.worktree_requested,
                    ..HostThread::default()
                }
            })
            .collect();
        host_projects.push(HostProject { id: p.id, path: p.path, name: p.name, scratch: p.scratch, threads });
    }
    let host = HostState { projects: host_projects, claude_path_override: legacy.claude_path_override.clone(), ..HostState::default() };
    let client = ClientState {
        groups: legacy.groups,
        projects: client_projects,
        threads: client_threads,
        selected_thread_id: legacy.selected_thread_id,
        sidebar_width: legacy.sidebar_width,
        notifications_enabled: legacy.notifications_enabled,
        completion_sound: legacy.completion_sound,
        activity_panel_visible: legacy.activity_panel_visible,
        claude_path_override: legacy.claude_path_override,
        ..ClientState::default()
    };
    (host, client)
}

/// Writes `host_dir/host.json` from `legacy_dir/state.json` once. Returns a notice when something went wrong.
pub fn migrate_host(legacy_dir: &Path, host_dir: &Path) -> Option<String> {
    migrate(legacy_dir, host_dir, HOST_MARKER, |legacy| split_legacy(legacy, "").0)
}

/// Writes `client_dir/client.json` from `legacy_dir/state.json` once. Returns a notice when something went wrong.
pub fn migrate_client(legacy_dir: &Path, client_dir: &Path, host_id: &str) -> Option<String> {
    migrate(legacy_dir, client_dir, CLIENT_MARKER, |legacy| split_legacy(legacy, host_id).1)
}

fn migrate<T: StoredState>(legacy_dir: &Path, dir: &Path, marker: &str, half: impl FnOnce(AppState) -> T) -> Option<String> {
    if dir.join(T::FILE).exists() || dir.join(marker).exists() {
        return None;
    }
    let legacy_path = legacy_dir.join("state.json");
    let bytes = match std::fs::read(&legacy_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => return Some(format!("Couldn't read {} to migrate it: {e}.", legacy_path.display())),
    };
    let (state, mut notice) = match serde_json::from_slice::<AppState>(&bytes) {
        Ok(legacy) => (half(legacy), None),
        Err(e) => (
            T::default(),
            Some(format!(
                "Speedy's old state at {} was unreadable ({e}), so {} starts empty. The original is left in place.",
                legacy_path.display(),
                T::FILE
            )),
        ),
    };
    let store = JsonStore::<T>::new(dir.to_path_buf());
    store.save(state);
    store.flush();
    // The store logs write errors rather than returning them; without the file, leave no marker so a later launch retries.
    if !dir.join(T::FILE).exists() {
        return Some(format!("Couldn't write {} in {} while migrating {}.", T::FILE, dir.display(), legacy_path.display()));
    }
    if let Err(e) = std::fs::write(dir.join(marker), b"") {
        notice.get_or_insert(format!("Couldn't write the migration marker in {}: {e}.", dir.display()));
    }
    notice
}

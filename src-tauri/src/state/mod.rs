//! U5: Speedy's own app state (KTD6). Transcripts stay with the CLI.

pub mod session_index;
pub mod store;

use std::path::PathBuf;

pub use store::{ensure_chats_project, AppState, Group, LoadResult, Project, StateStore, Thread};

/// `~/Library/Application Support/Speedy/`.
pub fn default_state_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Speedy")
}

/// Where Chats threads run: a Speedy-owned folder, so the CLI has a cwd and a session history.
pub fn chats_dir() -> PathBuf {
    default_state_dir().join("Chats")
}

#[tauri::command]
pub fn state_load(ctx: tauri::State<'_, crate::AppCtx>) -> LoadResult {
    let mut result = ctx.store.load();
    let dir = chats_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!("creating the Chats folder {} failed: {e}", dir.display());
    }
    ensure_chats_project(&mut result.state, &dir);
    result
}

/// Debounced, atomic save of the whole app state.
#[tauri::command]
pub fn state_save(ctx: tauri::State<'_, crate::AppCtx>, state: AppState) {
    ctx.store.save(state);
}

/// For each path, whether it exists on disk (missing projects render as missing).
#[tauri::command]
pub async fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    // Stat calls can block (e.g. on a slow network volume); keep them off the main thread.
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| std::path::Path::new(p).exists()).collect())
        .await
        .expect("paths_exist stat task panicked")
}

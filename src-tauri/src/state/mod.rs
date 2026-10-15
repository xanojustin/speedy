//! U5: Speedy's own app state (KTD6). Transcripts stay with the CLI.

pub mod session_index;
pub mod store;

use std::path::PathBuf;

pub use store::{AppState, LoadResult, Project, StateStore, Thread};

/// `~/Library/Application Support/Speedy/`.
pub fn default_state_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Speedy")
}

#[tauri::command]
pub fn state_load(ctx: tauri::State<'_, crate::AppCtx>) -> LoadResult {
    ctx.store.load()
}

/// Debounced, atomic save of the whole app state.
#[tauri::command]
pub fn state_save(ctx: tauri::State<'_, crate::AppCtx>, state: AppState) {
    ctx.store.save(state);
}

/// For each path, whether it exists on disk (missing projects render as missing).
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}

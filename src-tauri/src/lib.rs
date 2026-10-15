//! Speedy core: one `claude` actor and one PTY per thread, app state, and the
//! IPC surface the single React webview talks to.

pub mod attention;
pub mod claude;
pub mod env;
pub mod files;
pub mod menu;
pub mod pty;
pub mod state;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};

/// Everything the commands need, managed by Tauri as shared state.
pub struct AppCtx {
    pub env: Arc<env::EnvService>,
    pub sessions: Arc<claude::SessionManager>,
    pub ptys: Arc<pty::PtyManager>,
    pub store: Arc<state::StateStore>,
    pub attention: Arc<attention::Attention>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let env = Arc::new(env::EnvService::start());
            let attention = Arc::new(attention::Attention::new(handle.clone()));
            let sessions = Arc::new(claude::SessionManager::new(env.clone(), attention.clone()));
            let ptys = Arc::new(pty::PtyManager::new(env.clone(), handle.clone()));
            let store = Arc::new(state::StateStore::new(state::default_state_dir()));
            app.manage(AppCtx { env, sessions, ptys, store, attention });
            menu::install(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                if let Some(ctx) = window.app_handle().try_state::<AppCtx>() {
                    ctx.attention.set_app_focused(*focused);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            env::get_setup_state,
            env::recheck_setup,
            env::get_extension_settings,
            claude::claude_start,
            claude::claude_send_user,
            claude::claude_control,
            claude::claude_respond_permission,
            claude::claude_interrupt,
            claude::claude_stop,
            claude::claude_retry,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_has_foreground_child,
            state::state_load,
            state::state_save,
            state::paths_exist,
            state::session_index::sessions_list,
            state::session_index::session_load,
            state::session_index::session_rename_offline,
            files::files_search,
            attention::attention_set_visible,
            attention::attention_mark_read,
            open_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Speedy")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(ctx) = app.try_state::<AppCtx>() {
                    // KTD9: deny pending permissions, interrupt, then terminate process groups.
                    ctx.sessions.shutdown_all(std::time::Duration::from_secs(3));
                    ctx.ptys.shutdown_all(std::time::Duration::from_secs(3));
                    ctx.store.flush();
                }
            }
        });
}

/// Opens a web link or an existing document with the user's default handler
/// ("open file at line" defers to the default editor). Refuses anything that
/// would launch a program: app bundles, directories, executables, other URL schemes.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    check_openable(&path)?;
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn check_openable(path: &str) -> Result<(), String> {
    if ["https://", "http://", "mailto:"].iter().any(|p| path.starts_with(p)) {
        return Ok(());
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err(format!("refusing to open {path}: not an absolute path or web link"));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("cannot open {path}: {e}"))?;
    use std::os::unix::fs::PermissionsExt;
    if !meta.is_file() || meta.permissions().mode() & 0o111 != 0 {
        return Err(format!("refusing to open {path}: not a regular, non-executable file"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check_openable;

    #[test]
    fn open_path_allows_links_and_documents_only() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("notes.md");
        std::fs::write(&doc, "hi").unwrap();
        assert!(check_openable("https://example.com").is_ok());
        assert!(check_openable(doc.to_str().unwrap()).is_ok());
        assert!(check_openable("/Applications/Calculator.app").is_err());
        assert!(check_openable("/bin/ls").is_err());
        assert!(check_openable(dir.path().to_str().unwrap()).is_err());
        assert!(check_openable("file:///bin/ls").is_err());
        assert!(check_openable("relative.txt").is_err());
    }
}

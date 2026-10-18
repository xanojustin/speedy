//! Speedy app: a client of `speedy-agent` hosts (KTD1, KTD3, KTD11). The webview reaches
//! every host through [`hosts`]; this crate adds the macOS-only pieces (menu, `speedy`
//! command, notifications and Dock badge) and the app's own `client.json` preferences.

pub mod attention;
pub mod cli;
pub mod hosts;
pub mod menu;

use std::sync::Arc;

use speedy_core::host::migrate::migrate_client;
use speedy_core::state::client::ClientState;
use speedy_core::state::default_state_dir;
use speedy_core::state::store::{JsonStore, Loaded};
use tauri::{Manager, RunEvent, WindowEvent};

/// Everything the app's own commands need, managed by Tauri as shared state.
pub struct AppCtx {
    pub attention: Arc<attention::Attention>,
    /// The app's preferences; threads and projects belong to the hosts.
    pub client: JsonStore<ClientState>,
    pub client_notice: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(cli::PendingOpens::default())
        .manage(hosts::HostRegistry::new())
        .setup(|app| {
            let handle = app.handle().clone();
            let attention = Arc::new(attention::Attention::new(handle.clone()));
            // This Mac's preferences from the pre-hosts state.json, once (R18).
            let client_notice = migrate_client(&default_state_dir(), &default_state_dir(), hosts::LOCAL);
            let client = JsonStore::new(default_state_dir());
            let registry = app.state::<Arc<hosts::HostRegistry>>().inner().clone();
            let on_status = attention.clone();
            tauri::async_runtime::spawn(async move {
                registry.start_local(Arc::new(move |id: &str, from, to| on_status.on_status(id, "", from, to)));
            });
            app.manage(AppCtx { attention, client, client_notice });
            menu::install(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event
                && let Some(ctx) = window.app_handle().try_state::<AppCtx>()
            {
                ctx.attention.set_app_focused(*focused);
            }
        })
        .invoke_handler(tauri::generate_handler![
            client_state_load,
            client_state_save,
            attention::attention_set_visible,
            attention::attention_mark_read,
            attention::attention_set_titles,
            attention::attention_set_prefs,
            attention::play_sound,
            open_path,
            open_in_vscode,
            cli::open_folders_take,
            hosts::host_list,
            hosts::host_call,
            hosts::host_subscribe,
            hosts::host_thread_subscribe,
            hosts::host_pty_attach,
            hosts::host_pty_resize,
            hosts::host_unsubscribe,
            hosts::host_watch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Speedy")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                cli::handle_opened(app, urls);
            }
            // Threads and shells belong to the hosts' agents and keep running (R17, KTD11).
            if let RunEvent::ExitRequested { .. } = event
                && let Some(ctx) = app.try_state::<AppCtx>()
            {
                ctx.client.flush();
            }
        });
}

/// The app's preferences, with a notice when migrating them from state.json went wrong.
#[tauri::command]
fn client_state_load(ctx: tauri::State<'_, AppCtx>) -> Loaded<ClientState> {
    let mut loaded = ctx.client.load();
    loaded.notice = loaded.notice.or_else(|| ctx.client_notice.clone());
    loaded
}

/// Debounced, atomic save of the app's preferences.
#[tauri::command]
fn client_state_save(ctx: tauri::State<'_, AppCtx>, state: ClientState) {
    ctx.client.save(state);
}

/// Opens a web link or an existing document with the user's default handler
/// ("open file at line" defers to the default editor). Refuses anything that
/// would launch a program: app bundles, directories, executables, other URL schemes.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let mut cmd = std::process::Command::new("open");
    if is_web_link(&path) {
        cmd.arg(&path);
    } else {
        // Files always open as text in the default text editor, never via their
        // default handler (which can run `.terminal`, `.fileloc`, `.pkg`, …).
        check_openable(&path)?;
        let canon = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        cmd.args(["-t", "--"]).arg(canon);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a folder in VS Code by bundle id, so it works without the `code` CLI on PATH.
#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.is_dir() {
        return Err(format!("cannot open {path} in VS Code: not an existing folder"));
    }
    let status = std::process::Command::new("open")
        .args(["-b", "com.microsoft.VSCode", "--"])
        .arg(p)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("VS Code isn't installed".into()) }
}

fn is_web_link(path: &str) -> bool {
    ["https://", "http://", "mailto:"].iter().any(|p| path.starts_with(p))
}

fn check_openable(path: &str) -> Result<(), String> {
    if is_web_link(path) {
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

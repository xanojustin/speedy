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
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// App event carrying an SSH prompt for the webview: payload `hosts::askpass::Prompt`.
const ASKPASS_EVENT: &str = "askpass";
/// App event asking the webview to confirm quitting while This Mac's threads work: payload `{ working }`.
const QUIT_EVENT: &str = "quit_requested";

/// Set once the user confirmed quitting with threads working.
static QUIT_CONFIRMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
            let prompts = handle.clone();
            tauri::async_runtime::spawn(async move {
                match hosts::askpass::Askpass::start(move |prompt| {
                    if let Err(e) = prompts.emit(ASKPASS_EVENT, prompt) {
                        log::warn!("emitting {ASKPASS_EVENT}: {e}");
                    }
                }) {
                    Ok(askpass) => registry.set_askpass(askpass),
                    Err(e) => log::error!("SSH prompts won't work: {e}"),
                }
                registry.start_local(Arc::new(move |id: &str, from, to| on_status.on_status(id, "", from, to)));
                registry.start_saved();
                hosts::wake::on_wake(move || {
                    let registry = registry.clone();
                    tauri::async_runtime::spawn(async move { registry.woke().await });
                });
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
            hosts::host_aliases,
            hosts::host_add,
            hosts::host_remove,
            hosts::host_reconnect,
            hosts::askpass_answer,
            hosts::local_agent_stop,
            hosts::local_agent_start,
            quit_confirmed,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Speedy")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                cli::handle_opened(app, urls);
            }
            // Threads and shells belong to the hosts' agents and keep running (R17, KTD11).
            if let RunEvent::ExitRequested { api, .. } = &event {
                let working = app.try_state::<Arc<hosts::HostRegistry>>().map_or(0, |r| r.working(hosts::LOCAL));
                if working > 0 && !QUIT_CONFIRMED.load(std::sync::atomic::Ordering::SeqCst) {
                    // The webview says the threads keep running, then calls `quit_confirmed`.
                    api.prevent_exit();
                    let _ = app.emit(QUIT_EVENT, serde_json::json!({ "working": working }));
                    return;
                }
                if let Some(ctx) = app.try_state::<AppCtx>() {
                    ctx.client.flush();
                }
            }
        });
}

/// Quits after the user saw that This Mac's working threads keep running.
#[tauri::command]
fn quit_confirmed(app: tauri::AppHandle) {
    QUIT_CONFIRMED.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
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

/// Opens a folder in VS Code by bundle id, so it works without the `code` CLI on PATH. A
/// folder on an SSH host opens as a VS Code remote window on that alias (R16).
#[tauri::command]
fn open_in_vscode(hosts: tauri::State<'_, Arc<hosts::HostRegistry>>, path: String, host: Option<String>) -> Result<(), String> {
    if let Some(alias) = host.filter(|h| h != hosts::LOCAL) {
        // Only an added host, and an absolute path, become part of the URL.
        hosts.get(&alias)?;
        if !path.starts_with('/') {
            return Err(format!("cannot open {path} in VS Code: not an absolute path"));
        }
        let url = format!("vscode://vscode-remote/ssh-remote+{}{}", url_escape(&alias), url_escape(&path));
        let status = std::process::Command::new("open").arg(url).status().map_err(|e| e.to_string())?;
        return if status.success() { Ok(()) } else { Err("VS Code isn't installed".into()) };
    }
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

/// Percent-escapes everything but unreserved characters and `/`.
fn url_escape(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
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

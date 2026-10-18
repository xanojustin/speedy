//! U6: native menu with app-level accelerators (KTD10).
//! Each custom item emits the app event `menu` with its id as payload:
//! `new_thread`, `close_thread`, `toggle_terminal`, `maximize_terminal`, `new_terminal`,
//! `toggle_explorer`, `focus_chat`, `switch_thread_1` … `switch_thread_9`, `add_project`, `open_settings`,
//! `stop_local_agent`. They go to the focused window only, so a second window doesn't act too.
//! Accelerators live on native menu items so WKWebView can't swallow them.
//! `install_cli` and `new_window` are handled here in Rust (see `cli.rs`).

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder};

/// App event carrying a menu item id.
pub const MENU_EVENT: &str = "menu";

/// Custom "Thread" menu items: (id, label, accelerator). Ids mirror `MenuAction` in src/ipc/types.ts.
const THREAD_ITEMS: &[(&str, &str, &str)] = &[
    ("new_thread", "New Thread", "CmdOrCtrl+N"),
    ("close_thread", "Close Thread", "CmdOrCtrl+W"),
    ("add_project", "Add Project Folder…", "CmdOrCtrl+O"),
    ("toggle_terminal", "Toggle Terminal", "CmdOrCtrl+J"),
    (
        "maximize_terminal",
        "Maximize Terminal",
        "CmdOrCtrl+Shift+J",
    ),
    // VS Code's shortcut: Control, not Command, on macOS too.
    ("new_terminal", "New Terminal", "Ctrl+Shift+`"),
    ("toggle_explorer", "Toggle Explorer", "CmdOrCtrl+Shift+E"),
    ("focus_chat", "Focus Chat", "CmdOrCtrl+L"),
];

const INSTALL_CLI: &str = "install_cli";
const OPEN_SETTINGS: &str = "open_settings";
const NEW_WINDOW: &str = "new_window";
/// Asks the webview to confirm, then stops This Mac's agent (R17).
const STOP_LOCAL_AGENT: &str = "stop_local_agent";

const SWITCH_PREFIX: &str = "switch_thread_";

/// Whether a menu event id is one of ours (predefined items have their own ids).
fn is_app_action(id: &str) -> bool {
    id == OPEN_SETTINGS
        || id == STOP_LOCAL_AGENT
        || THREAD_ITEMS.iter().any(|(item, _, _)| *item == id)
        || id
            .strip_prefix(SWITCH_PREFIX)
            .is_some_and(|n| matches!(n.parse::<u8>(), Ok(1..=9)) && n.len() == 1)
}

pub fn install(app: &mut tauri::App) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "Speedy")
        .about_with_text(
            "About Speedy",
            Some(AboutMetadata {
                name: Some("Speedy".into()),
                ..Default::default()
            }),
        )
        .separator()
        .item(&MenuItemBuilder::with_id(OPEN_SETTINGS, "Settings…").accelerator("CmdOrCtrl+,").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id(INSTALL_CLI, "Install 'speedy' Command in PATH…").build(app)?)
        .item(&MenuItemBuilder::with_id(STOP_LOCAL_AGENT, "Stop This Mac's Agent…").build(app)?)
        .separator()
        .hide_with_text("Hide Speedy")
        .hide_others()
        .show_all()
        .separator()
        .quit_with_text("Quit Speedy")
        .build()?;

    // Predefined Edit items are required: without them Cmd+C/V/X/A/Z don't work in WKWebView.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let mut thread_menu = SubmenuBuilder::new(app, "Thread");
    for (i, (id, label, accel)) in THREAD_ITEMS.iter().enumerate() {
        let item = MenuItemBuilder::with_id(*id, *label)
            .accelerator(*accel)
            .build(app)?;
        thread_menu = thread_menu.item(&item);
        if i == 1 || i == 2 {
            thread_menu = thread_menu.separator();
        }
    }
    thread_menu = thread_menu.separator();
    for n in 1..=9 {
        let item = MenuItemBuilder::with_id(format!("{SWITCH_PREFIX}{n}"), format!("Thread {n}"))
            .accelerator(format!("CmdOrCtrl+{n}"))
            .build(app)?;
        thread_menu = thread_menu.item(&item);
    }
    let thread_menu = thread_menu.build()?;

    // No predefined Close Window item: Cmd+W closes threads.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&MenuItemBuilder::with_id(NEW_WINDOW, "New Window").accelerator("CmdOrCtrl+Shift+N").build(app)?)
        .separator()
        .minimize()
        .maximize_with_text("Zoom")
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &thread_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == INSTALL_CLI {
            crate::cli::install_command(app);
        } else if id == NEW_WINDOW {
            if let Err(err) = new_window(app) {
                log::warn!("opening a window failed: {err}");
            }
        } else if is_app_action(id) {
            let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
            let sent = match focused {
                Some(w) => app.emit_to(EventTarget::webview_window(w.label()), MENU_EVENT, id),
                None => app.emit(MENU_EVENT, id),
            };
            if let Err(err) = sent {
                log::warn!("failed to emit menu event {id}: {err}");
            }
        }
    });
    Ok(())
}

/// Another window on the same hosts (R10): it subscribes on its own and sees the same threads.
fn new_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    static NEXT: AtomicU32 = AtomicU32::new(2);
    let label = format!("window-{}", NEXT.fetch_add(1, Ordering::SeqCst));
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Speedy")
        .inner_size(1440.0, 920.0)
        .min_inner_size(800.0, 500.0)
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_app_action;

    #[test]
    fn only_custom_items_are_forwarded_to_the_webview() {
        for id in [
            "new_thread",
            "close_thread",
            "add_project",
            "toggle_terminal",
            "maximize_terminal",
            "new_terminal",
            "toggle_explorer",
            "focus_chat",
            "open_settings",
        ] {
            assert!(is_app_action(id), "{id}");
        }
        for n in 1..=9 {
            assert!(is_app_action(&format!("switch_thread_{n}")));
        }
        for id in [
            "switch_thread_0",
            "switch_thread_10",
            "switch_thread_",
            "copy",
            "quit",
            "",
        ] {
            assert!(!is_app_action(id), "{id}");
        }
    }
}

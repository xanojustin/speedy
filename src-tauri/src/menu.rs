//! U6: native menu with app-level accelerators (KTD10).
//! Each custom item emits the app event `menu` with its id as payload:
//! `new_thread`, `close_thread`, `toggle_terminal`, `maximize_terminal`,
//! `focus_chat`, `switch_thread_1` … `switch_thread_9`, `add_project`.
//! Accelerators live on native menu items so WKWebView can't swallow them.

use tauri::Emitter;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

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
    ("focus_chat", "Focus Chat", "CmdOrCtrl+L"),
];

const SWITCH_PREFIX: &str = "switch_thread_";

/// Whether a menu event id is one of ours (predefined items have their own ids).
fn is_app_action(id: &str) -> bool {
    THREAD_ITEMS.iter().any(|(item, _, _)| *item == id)
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
        .minimize()
        .maximize_with_text("Zoom")
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &thread_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if is_app_action(id)
            && let Err(err) = app.emit(MENU_EVENT, id)
        {
            log::warn!("failed to emit menu event {id}: {err}");
        }
    });
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
            "focus_chat",
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

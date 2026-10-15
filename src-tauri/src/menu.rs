//! U6: native menu with app-level accelerators (KTD10). STUB.
//! Each custom item emits the app event `menu` with its id as payload:
//! `new_thread`, `close_thread`, `toggle_terminal`, `maximize_terminal`,
//! `focus_chat`, `switch_thread_1` … `switch_thread_9`, `add_project`.

/// App event carrying a menu item id.
pub const MENU_EVENT: &str = "menu";

pub fn install(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

//! U12: notifications and Dock badge for threads needing attention. STUB.

use serde::Serialize;
use tauri::AppHandle;

use crate::claude::ThreadStatus;

/// App event emitted when a notification is clicked: payload `{ threadId }`.
pub const OPEN_THREAD_EVENT: &str = "attention-open-thread";
/// App event with the full unread set: payload `{ unread: string[] }`.
pub const UNREAD_EVENT: &str = "attention-unread";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenThread {
    pub thread_id: String,
}

pub struct Attention {
    #[allow(dead_code)]
    app: AppHandle,
}

impl Attention {
    pub fn new(app: AppHandle) -> Self {
        Attention { app }
    }

    /// Called by the session actor on every status transition.
    pub fn on_status(&self, _thread_id: &str, _thread_title: &str, _from: ThreadStatus, _to: ThreadStatus) {}

    pub fn set_app_focused(&self, _focused: bool) {}
}

/// The thread currently visible in the UI (None when nothing is selected).
#[tauri::command]
pub fn attention_set_visible(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: Option<String>) {}

#[tauri::command]
pub fn attention_mark_read(_ctx: tauri::State<'_, crate::AppCtx>, _thread_id: String) {}

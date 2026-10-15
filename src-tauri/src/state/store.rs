//! U5: versioned, atomically written app state with debounced saves. STUB bodies.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub version: u32,
    pub projects: Vec<Project>,
    pub selected_thread_id: Option<String>,
    pub claude_path_override: Option<String>,
    pub sidebar_width: f64,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            version: STATE_VERSION,
            projects: vec![],
            selected_thread_id: None,
            claude_path_override: None,
            sidebar_width: 260.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    pub collapsed: bool,
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Thread {
    pub id: String,
    pub title: String,
    /// The CLI session this thread is bound to (one thread ↔ one session).
    pub session_id: Option<String>,
    pub archived: bool,
    pub created_at: u64,
    /// Chat share of the chat/terminal split, 0..1.
    pub split_ratio: f64,
    pub terminal_visible: bool,
    pub terminal_maximized: bool,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
}

impl Default for Thread {
    fn default() -> Self {
        Thread {
            id: String::new(),
            title: "New thread".into(),
            session_id: None,
            archived: false,
            created_at: 0,
            split_ratio: 0.65,
            terminal_visible: true,
            terminal_maximized: false,
            model: None,
            permission_mode: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub state: AppState,
    /// Set when the state file was corrupt and moved aside.
    pub notice: Option<String>,
}

pub struct StateStore {
    #[allow(dead_code)]
    dir: PathBuf,
}

impl StateStore {
    pub fn new(dir: PathBuf) -> Self {
        StateStore { dir }
    }

    pub fn load(&self) -> LoadResult {
        LoadResult { state: AppState::default(), notice: None }
    }

    /// Schedules a debounced atomic write.
    pub fn save(&self, _state: AppState) {}

    /// Writes any pending state immediately (quit).
    pub fn flush(&self) {}
}

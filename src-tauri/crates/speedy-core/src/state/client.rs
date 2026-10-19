//! U10: the app's own preferences in `client.json` (KTD6): groups, ordering, layout,
//! selection and notification settings, keyed by `(host_id, project_id)`.

use serde::{Deserialize, Serialize};

use super::store::{Group, StoredState};

pub const CLIENT_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientState {
    pub version: u32,
    /// Sidebar sections that projects can be filed under, in display order.
    pub groups: Vec<Group>,
    /// Per-project prefs, in display order.
    pub projects: Vec<ClientProject>,
    pub threads: Vec<ClientThread>,
    pub selected_thread_id: Option<String>,
    pub sidebar_width: f64,
    /// Post a system notification when a hidden thread finishes or needs input.
    pub notifications_enabled: bool,
    /// System sound played when a thread needs attention; None = silent.
    pub completion_sound: Option<String>,
    /// Show the activity panel (the agent's todos and subagents) above the composer.
    pub activity_panel_visible: bool,
    /// This Mac's `claude` path when it isn't on the login PATH.
    pub claude_path_override: Option<String>,
    /// Hosts whose sidebar section is collapsed, by host key.
    pub collapsed_hosts: Vec<String>,
    /// "system", "light" or "dark".
    pub theme: String,
}

impl Default for ClientState {
    fn default() -> Self {
        ClientState {
            version: CLIENT_STATE_VERSION,
            groups: vec![],
            projects: vec![],
            threads: vec![],
            selected_thread_id: None,
            sidebar_width: 260.0,
            notifications_enabled: true,
            completion_sound: None,
            activity_panel_visible: false,
            claude_path_override: None,
            collapsed_hosts: vec![],
            theme: "system".into(),
        }
    }
}

impl StoredState for ClientState {
    const FILE: &'static str = "client.json";
    fn stamp_version(&mut self) {
        self.version = CLIENT_STATE_VERSION;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientProject {
    pub host_id: String,
    pub project_id: String,
    pub collapsed: bool,
    /// The group this project is filed under; None (or an unknown id) = ungrouped.
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientThread {
    pub thread_id: String,
    /// Chat share of the chat/terminal split, 0..1.
    pub split_ratio: f64,
    pub terminal_visible: bool,
    pub terminal_maximized: bool,
    pub explorer_visible: bool,
}

impl Default for ClientThread {
    fn default() -> Self {
        ClientThread {
            thread_id: String::new(),
            split_ratio: 0.65,
            terminal_visible: false,
            terminal_maximized: false,
            explorer_visible: false,
        }
    }
}

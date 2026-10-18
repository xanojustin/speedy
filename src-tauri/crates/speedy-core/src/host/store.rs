//! U5: what the agent persists in `host.json` (KTD6): the host's projects and threads,
//! including each thread's session binding and queue. Client-only fields (groups,
//! ordering, layout) live in the app's `client.json` instead.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::store::{StoredState, ThreadWorktree};

pub const HOST_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostState {
    pub version: u32,
    pub projects: Vec<HostProject>,
    pub claude_path_override: Option<String>,
}

impl Default for HostState {
    fn default() -> Self {
        HostState { version: HOST_STATE_VERSION, projects: vec![], claude_path_override: None }
    }
}

impl StoredState for HostState {
    const FILE: &'static str = "host.json";
    fn stamp_version(&mut self) {
        self.version = HOST_STATE_VERSION;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HostProject {
    pub id: String,
    pub path: String,
    pub name: String,
    /// The host's Chats project: threads not tied to any folder.
    pub scratch: bool,
    pub threads: Vec<HostThread>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostThread {
    pub id: String,
    pub title: String,
    /// The CLI session this thread is bound to (one thread ↔ one session).
    pub session_id: Option<String>,
    pub archived: bool,
    pub created_at: u64,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// Set when the thread runs in its own git worktree instead of the project folder.
    pub worktree: Option<ThreadWorktree>,
    /// Create a worktree before the thread's first start.
    pub worktree_requested: bool,
    /// A rewind fork's starting point; cleared once the fork's own session is bound.
    pub fork: Option<ForkFrom>,
    /// Messages waiting for the current turn to finish, sent in order.
    pub queue: Vec<QueueItem>,
}

pub const DEFAULT_TITLE: &str = "New thread";

impl Default for HostThread {
    fn default() -> Self {
        HostThread {
            id: String::new(),
            title: DEFAULT_TITLE.into(),
            session_id: None,
            archived: false,
            created_at: 0,
            model: None,
            permission_mode: None,
            worktree: None,
            worktree_requested: false,
            fork: None,
            queue: vec![],
        }
    }
}

/// Where a rewind fork starts: `resume_session_id` truncated at `resume_session_at`, as a new session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ForkFrom {
    pub resume_session_id: String,
    pub resume_session_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct QueueItem {
    pub id: String,
    /// An Anthropic content-block array.
    pub content: Value,
}

impl HostState {
    pub fn thread(&self, id: &str) -> Option<(&HostProject, &HostThread)> {
        self.projects.iter().find_map(|p| p.threads.iter().find(|t| t.id == id).map(|t| (p, t)))
    }

    pub fn thread_mut(&mut self, id: &str) -> Option<&mut HostThread> {
        self.projects.iter_mut().flat_map(|p| p.threads.iter_mut()).find(|t| t.id == id)
    }

    pub fn project_mut(&mut self, id: &str) -> Option<&mut HostProject> {
        self.projects.iter_mut().find(|p| p.id == id)
    }
}

impl HostThread {
    /// Where the thread's `claude` runs: its worktree, or the project folder.
    pub fn cwd(&self, project: &HostProject) -> String {
        self.worktree.as_ref().map_or_else(|| project.path.clone(), |w| w.path.clone())
    }
}

//! Speedy's host-side core, with no Tauri dependency (KTD1): one `claude` actor and
//! PTYs per thread, file search, the explorer and git, worktrees, session history,
//! app state, and the attention state machine. The app wraps these as Tauri commands.

pub mod attention;
pub mod claude;
pub mod env;
pub mod explorer;
pub mod files;
pub mod host;
pub mod proc_group;
pub mod proto;
pub mod pty;
pub mod state;
pub mod worktree;

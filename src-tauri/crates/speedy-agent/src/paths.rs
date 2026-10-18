//! U6: where the agent keeps its files. Everything lives under `~/.speedy/agent`, kept short
//! so the socket path stays under macOS's 104-byte `sun_path` limit (KTD2).
//! `SPEEDY_AGENT_HOME` overrides the root (tests, and a second agent on one machine).

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct AgentPaths {
    pub root: PathBuf,
}

impl AgentPaths {
    pub fn from_env() -> Self {
        let root = std::env::var_os("SPEEDY_AGENT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".speedy/agent"));
        AgentPaths { root }
    }

    /// Mode 0700; holds the socket, lock, host id and `host.json`.
    pub fn state_dir(&self) -> PathBuf {
        self.root.join("state")
    }

    pub fn socket(&self) -> PathBuf {
        self.state_dir().join("agent.sock")
    }

    pub fn lock(&self) -> PathBuf {
        self.state_dir().join("agent.lock")
    }

    pub fn host_id(&self) -> PathBuf {
        self.state_dir().join("host-id")
    }
}

//! U7: the `claude` token for hosts where it can't reach the login Keychain (KTD8).
//!
//! The token arrives only through the `set_claude_token` RPC and lives in a 0600 file in the
//! agent's state dir. It is set on the `claude` child's environment and nowhere else: never in
//! the shared env that shells and git use, `host.json`, events, snapshots, results or logs.

use std::collections::HashMap;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;

use crate::paths::AgentPaths;

const TOKEN_FILE: &str = "claude-token";
const TOKEN_VAR: &str = "CLAUDE_CODE_OAUTH_TOKEN";

pub fn token_present(paths: &AgentPaths) -> bool {
    paths.state_dir().join(TOKEN_FILE).exists()
}

/// Writes the token, created 0600 at open and renamed into place.
pub fn set_token(paths: &AgentPaths, token: &str) -> io::Result<()> {
    let dir = paths.state_dir();
    let tmp = dir.join(format!(".{TOKEN_FILE}-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
    f.write_all(token.trim().as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, dir.join(TOKEN_FILE))
}

/// `shared` plus the token, for the `claude` child only.
pub fn claude_env(paths: &AgentPaths, mut shared: HashMap<String, String>) -> HashMap<String, String> {
    if let Ok(token) = std::fs::read_to_string(paths.state_dir().join(TOKEN_FILE)) {
        shared.insert(TOKEN_VAR.into(), token.trim().to_owned());
    }
    shared
}

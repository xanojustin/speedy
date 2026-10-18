//! U7: the fallback when no console session exists (KTD8): the agent detaches itself into a
//! new session, so the SSH session that started it can end. macOS has no `setsid` command,
//! so the child calls `setsid()` before exec. `claude` then needs a token (`token.rs`).

use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::paths::AgentPaths;

/// Stops a running agent, then starts `bin/current/speedy-agent run` detached.
pub fn restart_detached(paths: &AgentPaths) -> io::Result<()> {
    let program = paths.current_binary();
    let _ = Command::new(&program).arg("stop").env("SPEEDY_AGENT_HOME", &paths.root).status();
    std::fs::create_dir_all(crate::logs::log_dir())?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(crate::logs::log_dir().join("detached.log"))?;
    let mut cmd = Command::new(&program);
    cmd.arg("run")
        .env("SPEEDY_AGENT_HOME", &paths.root)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    unsafe {
        cmd.pre_exec(|| {
            // A new session: no controlling terminal, so no SIGHUP when ssh goes away.
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn()?;
    // Wait for the new agent to take the lock, so the caller can connect right away.
    for _ in 0..50 {
        if crate::daemon::agent_running(paths) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(io::Error::other("the agent didn't start; see ~/Library/Logs/speedy-agent/detached.log"))
}

//! U11: reaching a host through the user's own `/usr/bin/ssh` (KTD2), so `~/.ssh/config`,
//! ProxyJump, agents and 1Password's `IdentityAgent` all just work. Each host gets a private
//! ControlMaster (`ControlPersist=no`, owned by the app) that every probe, upload and proxy
//! shares, so the user authenticates once per connection. Passphrase and 2FA prompts go
//! through `SSH_ASKPASS` to the app (`askpass.rs`).

use std::path::Path;
use std::pin::Pin;
use std::process::{Output, Stdio};
use std::task::{Context, Poll};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const SSH: &str = "/usr/bin/ssh";
const SCP: &str = "/usr/bin/scp";
const MASTER_TIMEOUT: Duration = Duration::from_secs(60);

pub struct Ssh {
    pub alias: String,
    /// `~/.speedy/cm/%C`: short, so it stays under the 104-byte socket path limit.
    control_path: String,
    master: Mutex<Option<Child>>,
    /// Env that routes prompts to the app, when this connect may ask the user.
    askpass: Mutex<Option<Vec<(String, String)>>>,
}

/// Whether `alias` is safe to hand ssh and scp as a destination: a concrete entry in the
/// user's ssh config, which can't be read as an option (`-o…`), split into several
/// arguments, or parsed by scp as a path (`:` or `/`). The webview sends aliases, so this is
/// what keeps one from running a command on this Mac.
pub fn valid_alias(alias: &str, configured: &[String]) -> bool {
    !alias.is_empty()
        && !alias.starts_with('-')
        && !alias.chars().any(|c| c.is_whitespace() || c.is_control() || c == ':' || c == '/')
        && configured.iter().any(|a| a == alias)
}

impl Ssh {
    /// Callers check the alias with [`valid_alias`] first.
    pub fn new(alias: &str) -> Ssh {
        let dir = dirs::home_dir().unwrap_or_default().join(".speedy/cm");
        let _ = std::fs::create_dir_all(&dir);
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        Ssh {
            alias: alias.to_owned(),
            control_path: dir.join("%C").to_string_lossy().into_owned(),
            master: Mutex::new(None),
            askpass: Mutex::new(None),
        }
    }

    /// Lets the next master start ask for a passphrase or code (a user-initiated connect).
    /// Without it, ssh can't prompt, so a background reconnect fails instead of popping a dialog.
    pub fn allow_prompts(&self, env: Option<Vec<(String, String)>>) {
        *self.askpass.lock() = env;
    }

    fn base(&self, program: &str) -> Command {
        let mut cmd = Command::new(program);
        cmd.args(["-o", "ControlMaster=no", "-o", &format!("ControlPath={}", self.control_path)]);
        cmd.stdin(Stdio::null()).kill_on_drop(true);
        cmd
    }

    /// Starts the master if none is up, waiting until it accepts sessions.
    pub async fn ensure_master(&self) -> Result<(), String> {
        if self.check().await {
            return Ok(());
        }
        let mut cmd = Command::new(SSH);
        cmd.args([
            "-N",
            "-o",
            "ControlMaster=yes",
            "-o",
            "ControlPersist=no",
            "-o",
            &format!("ControlPath={}", self.control_path),
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ConnectTimeout=15",
            "--",
            &self.alias,
        ]);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        match self.askpass.lock().clone() {
            Some(env) => {
                cmd.envs(env).env("SSH_ASKPASS_REQUIRE", "force");
            }
            None => {
                cmd.args(["-o", "BatchMode=yes"]);
            }
        }
        let mut child = cmd.spawn().map_err(|e| format!("starting ssh: {e}"))?;
        let deadline = tokio::time::Instant::now() + MASTER_TIMEOUT;
        // Quick at first, then slower while the user answers a prompt.
        let mut wait = Duration::from_millis(150);
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                let mut err = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    use tokio::io::AsyncReadExt;
                    let _ = stderr.read_to_string(&mut err).await;
                }
                return Err(ssh_error(err.trim(), status.code()));
            }
            if self.check().await {
                *self.master.lock() = Some(child);
                return Ok(());
            }
            if tokio::time::Instant::now() > deadline {
                return Err(format!("ssh to {} timed out", self.alias));
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(1));
        }
    }

    async fn check(&self) -> bool {
        let mut cmd = self.base(SSH);
        cmd.args(["-O", "check", "--", &self.alias]).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.status().await.is_ok_and(|s| s.success())
    }

    /// Ends the master (wake from sleep, remove host). The next connect starts a fresh one.
    pub async fn drop_master(&self) {
        let mut cmd = self.base(SSH);
        cmd.args(["-O", "exit", "--", &self.alias]).stdout(Stdio::null()).stderr(Stdio::null());
        let _ = cmd.status().await;
        let child = self.master.lock().take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
        }
    }

    /// Runs `script` with `/bin/sh` on the host, fed on stdin so the user's login shell never
    /// has to parse it.
    pub async fn sh(&self, script: &str) -> Result<Output, String> {
        let mut cmd = self.base(SSH);
        cmd.args(["-T", "--", &self.alias, "/bin/sh", "-s"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
        let mut stdin = child.stdin.take().expect("piped");
        stdin.write_all(script.as_bytes()).await.map_err(|e| e.to_string())?;
        drop(stdin);
        child.wait_with_output().await.map_err(|e| e.to_string())
    }

    /// Copies `local` to `remote` (relative to the host's home).
    pub async fn upload(&self, local: &Path, remote: &str) -> Result<(), String> {
        let mut cmd = self.base(SCP);
        cmd.args(["-q", "--"]).arg(local).arg(format!("{}:{remote}", self.alias)).stdout(Stdio::null()).stderr(Stdio::piped());
        let out = cmd.output().await.map_err(|e| format!("scp: {e}"))?;
        if out.status.success() { Ok(()) } else { Err(format!("uploading the agent: {}", String::from_utf8_lossy(&out.stderr).trim())) }
    }

    /// A byte stream to the host's agent through `speedy-agent proxy`.
    pub fn proxy(&self, agent: &str) -> Result<ProxyStream, String> {
        let mut cmd = self.base(SSH);
        cmd.args(["-T", "--", &self.alias, agent, "proxy"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
        let stdout = child.stdout.take().expect("piped");
        let stdin = child.stdin.take().expect("piped");
        Ok(ProxyStream { _child: child, stdout, stdin })
    }
}

impl Drop for Ssh {
    fn drop(&mut self) {
        if let Some(mut child) = self.master.lock().take() {
            let _ = child.start_kill();
        }
    }
}

/// ssh's own message, or a clearer one for the cases people hit most.
fn ssh_error(stderr: &str, code: Option<i32>) -> String {
    if stderr.contains("Host key verification failed") {
        return "The host key isn't trusted yet. Connect once with ssh in a terminal to accept it.".into();
    }
    if stderr.contains("Permission denied") {
        return format!("SSH refused the login: {stderr}");
    }
    if stderr.is_empty() { format!("ssh exited with {code:?}") } else { stderr.to_owned() }
}

/// `ssh … proxy`'s stdout and stdin as one stream; the child dies with it.
pub struct ProxyStream {
    _child: Child,
    stdout: ChildStdout,
    stdin: ChildStdin,
}

impl AsyncRead for ProxyStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for ProxyStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

/// Where the agent lives on every host, relative to its home.
pub const REMOTE_AGENT: &str = ".speedy/agent/bin/current/speedy-agent";

#[cfg(test)]
mod tests {
    use super::ssh_error;

    #[test]
    fn ssh_errors_explain_the_common_failures() {
        let untrusted = ssh_error("Host key verification failed.\r\n", Some(255));
        assert_eq!(untrusted, "The host key isn't trusted yet. Connect once with ssh in a terminal to accept it.");
        let refused = "justin@mac-mini: Permission denied (publickey,keyboard-interactive).";
        assert_eq!(ssh_error(refused, Some(255)), format!("SSH refused the login: {refused}"));
        assert_eq!(ssh_error("", Some(255)), "ssh exited with Some(255)");
        assert_eq!(ssh_error("", None), "ssh exited with None");
        let other = "ssh: Could not resolve hostname nope: nodename nor servname provided";
        assert_eq!(ssh_error(other, Some(255)), other, "anything else is ssh's own words");
    }
}

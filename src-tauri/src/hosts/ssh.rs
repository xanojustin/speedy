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
        self.kill_orphans().await;
        if self.check().await {
            return Ok(());
        }
        self.remove_dead_socket().await;
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
        // Options go before the destination; anything after it is the remote command.
        cmd.args(["--", &self.alias]);
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

    /// Deletes a socket left by a master that died without cleaning up (crash, force-quit,
    /// sleep). While it exists, a new master can't bind the path and runs unshared, so
    /// `check` never passes and every connect times out. Only a socket nobody listens on is
    /// removed, so a live master is never cut off.
    async fn remove_dead_socket(&self) {
        let mut cmd = Command::new(SSH);
        cmd.args(["-G", "-o", &format!("ControlPath={}", self.control_path), "--", &self.alias]);
        cmd.stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        let Ok(out) = cmd.output().await else { return };
        let Some(path) = control_path_from_config(&String::from_utf8_lossy(&out.stdout)) else { return };
        if is_dead_socket(Path::new(&path)) {
            let _ = std::fs::remove_file(&path);
        }
    }

    /// Kills this host's masters left by an earlier run of the app that crashed or quit.
    /// launchd adopts them, so they're the ones whose parent is pid 1; the masters of a
    /// Speedy still running (a dev build beside the installed app) are left alone. A
    /// leftover master either holds a connection nothing uses or keeps the socket for the
    /// session it died with.
    async fn kill_orphans(&self) {
        let mut cmd = Command::new("/bin/ps");
        cmd.args(["-axo", "pid=,ppid=,command="]).stdin(Stdio::null()).stderr(Stdio::null());
        let Ok(out) = cmd.output().await else { return };
        let orphans = orphan_masters(&String::from_utf8_lossy(&out.stdout), &self.alias, &self.control_path);
        for pid in &orphans {
            // SAFETY: kill(2) only sends a signal.
            unsafe { libc::kill(*pid, libc::SIGTERM) };
        }
        if !orphans.is_empty() {
            // A master removes its socket as it exits; give it a moment so `check` sees that.
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Ends the master now, without waiting: for app exit, which skips `Drop`. SIGTERM, not
    /// SIGKILL, so ssh removes its socket on the way out.
    pub fn kill_master(&self) {
        if let Some(mut child) = self.master.lock().take() {
            match child.id() {
                // SAFETY: kill(2) only sends a signal.
                Some(pid) => unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                },
                None => {
                    let _ = child.start_kill();
                }
            }
        }
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
        self.kill_master();
    }
}

/// From `ps -axo pid=,ppid=,command=`: the pids of masters for `alias` on `control_path`
/// whose parent is launchd, i.e. whose app is gone.
fn orphan_masters(ps: &str, alias: &str, control_path: &str) -> Vec<libc::pid_t> {
    let path_opt = format!("ControlPath={control_path}");
    ps.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid: libc::pid_t = fields.next()?.parse().ok()?;
            let ppid: libc::pid_t = fields.next()?.parse().ok()?;
            let args: Vec<&str> = fields.collect();
            let is_master = args.first() == Some(&SSH)
                && args.contains(&"-N")
                && args.contains(&"ControlMaster=yes")
                && line.contains(&path_opt);
            let destination = args.iter().position(|a| *a == "--").and_then(|i| args.get(i + 1));
            (ppid == 1 && is_master && destination == Some(&alias)).then_some(pid)
        })
        .collect()
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

/// The expanded `controlpath` line from `ssh -G` output.
fn control_path_from_config(config: &str) -> Option<String> {
    config.lines().find_map(|line| line.strip_prefix("controlpath ")).map(str::to_owned).filter(|p| p != "none")
}

/// Whether `path` is a socket that refuses connections: no master is behind it.
fn is_dead_socket(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    let is_socket = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket());
    is_socket
        && std::os::unix::net::UnixStream::connect(path)
            .is_err_and(|e| e.kind() == std::io::ErrorKind::ConnectionRefused)
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
    use super::{control_path_from_config, is_dead_socket, orphan_masters, ssh_error};

    #[test]
    fn only_this_hosts_masters_without_an_app_are_orphans() {
        let cp = "/Users/justin/.speedy/cm/%C";
        let master = |alias: &str| {
            format!("/usr/bin/ssh -N -o ControlMaster=yes -o ControlPersist=no -o ControlPath={cp} -o ConnectTimeout=15 -o BatchMode=yes -- {alias}")
        };
        let ps = [
            format!("45098     1 {}", master("mac-mini")),
            // An older build put BatchMode after the destination.
            format!("  301     1 {} -o BatchMode=yes", master("mac-mini")),
            format!("46749 45556 {}", master("mac-mini")),
            format!("  500     1 {}", master("mac-mini-2")),
            format!("  501     1 {}", master("mac-mini").replace(cp, "/tmp/other/%C")),
            format!("  502     1 /usr/bin/ssh -o ControlMaster=no -o ControlPath={cp} -T -- mac-mini /bin/sh -s"),
            "  503     1 /usr/bin/ssh -N mac-mini".to_owned(),
            "garbage".to_owned(),
        ]
        .join("\n");
        assert_eq!(orphan_masters(&ps, "mac-mini", cp), vec![45098, 301]);
    }

    #[test]
    fn the_control_path_comes_from_ssh_config_output() {
        let config = "user justin\ncontrolpath /Users/justin/.speedy/cm/39e4\nport 22\n";
        assert_eq!(control_path_from_config(config).as_deref(), Some("/Users/justin/.speedy/cm/39e4"));
        assert_eq!(control_path_from_config("controlpath none\n"), None);
        assert_eq!(control_path_from_config("user justin\n"), None);
    }

    #[test]
    fn only_a_socket_nobody_listens_on_is_dead() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        let _listener = std::os::unix::net::UnixListener::bind(&live).unwrap();
        assert!(!is_dead_socket(&live), "a master is listening");

        let dead = dir.path().join("dead");
        drop(std::os::unix::net::UnixListener::bind(&dead).unwrap());
        assert!(is_dead_socket(&dead), "the listener is gone but the file stayed");

        let file = dir.path().join("file");
        std::fs::write(&file, "").unwrap();
        assert!(!is_dead_socket(&file), "not a socket");
        assert!(!is_dead_socket(&dir.path().join("missing")));
    }

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

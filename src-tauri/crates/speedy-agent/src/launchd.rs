//! U7: running the agent as a per-user LaunchAgent in the `gui/<uid>` domain (KTD8).
//!
//! An agent started from an SSH session lands in the Background domain, where `claude`
//! can't read its login Keychain item. A LaunchAgent bootstrapped into `gui/<uid>` gets the
//! console session's security context instead, survives the SSH session, and is restarted
//! by launchd if it crashes. With nobody logged in at the console that domain doesn't exist;
//! `install` then detaches the agent itself and `claude` needs a token (`token.rs`).

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths::AgentPaths;

pub const LABEL: &str = "dev.brecht.speedy.agent";

/// The launchd security domain this process runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Domain {
    /// The console login session: the Keychain is available.
    Aqua,
    /// SSH or another non-GUI session: it isn't.
    Background,
    Other(String),
}

/// `launchctl managername`.
pub fn current_domain() -> Domain {
    let out = Command::new("/bin/launchctl").arg("managername").output();
    match out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()) {
        Ok(name) if name == "Aqua" => Domain::Aqua,
        Ok(name) if name == "Background" => Domain::Background,
        Ok(name) => Domain::Other(name),
        Err(e) => Domain::Other(e.to_string()),
    }
}

/// Whether a console login session exists to bootstrap into.
pub fn gui_domain_available() -> bool {
    Command::new("/bin/launchctl")
        .args(["print", &format!("gui/{}", uid())])
        .output()
        .is_ok_and(|o| o.status.success())
}

pub fn plist_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(format!("Library/LaunchAgents/{LABEL}.plist"))
}

/// The LaunchAgent: `bin/current/speedy-agent run`, restarted only when it exits non-zero,
/// and not throttled like a background job. `home` is set only for a non-default root.
pub fn plist(paths: &AgentPaths, home: Option<&Path>) -> String {
    let program = paths.current_binary();
    let env = home.map_or_else(String::new, |h| {
        format!(
            "\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>SPEEDY_AGENT_HOME</key>\n\t\t<string>{}</string>\n\t</dict>\n",
            xml_escape(&h.to_string_lossy())
        )
    });
    let log = crate::logs::log_dir().join("launchd.log");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{program}</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
{env}</dict>
</plist>
"#,
        program = xml_escape(&program.to_string_lossy()),
        log = xml_escape(&log.to_string_lossy()),
    )
}

/// Points `bin/current` at `bin_dir`, atomically.
pub fn set_current(paths: &AgentPaths, bin_dir: &Path) -> io::Result<()> {
    let bin = paths.root.join("bin");
    std::fs::create_dir_all(&bin)?;
    let tmp = bin.join(format!(".current-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(bin_dir, &tmp)?;
    std::fs::rename(&tmp, bin.join("current"))
}

/// Installs and (re)starts the agent from `bin/current`: as a LaunchAgent when a console
/// session exists, otherwise as a detached process. Restarting kills a running agent, so
/// `install` first has it exit through [`crate::daemon::restart_if_idle`] (KTD9).
pub fn install(paths: &AgentPaths, home: Option<&Path>) -> io::Result<&'static str> {
    if !gui_domain_available() {
        crate::daemonize::restart_detached(paths)?;
        return Ok("background");
    }
    let path = plist_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::create_dir_all(crate::logs::log_dir())?;
    std::fs::write(&path, plist(paths, home))?;
    let domain = format!("gui/{}", uid());
    // Unload any older definition first; failure just means it wasn't loaded.
    let _ = Command::new("/bin/launchctl").args(["bootout", &format!("{domain}/{LABEL}")]).output();
    launchctl(&["bootstrap", &domain, &path.to_string_lossy()])?;
    launchctl(&["kickstart", "-k", &format!("{domain}/{LABEL}")])?;
    Ok("launchd")
}

fn launchctl(args: &[&str]) -> io::Result<()> {
    let out = Command::new("/bin/launchctl").args(args).output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("launchctl {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim())))
    }
}

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

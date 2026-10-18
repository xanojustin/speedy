//! U8: This Mac's agent (KTD9, KTD11). The app bundles `speedy-agent` as a sidecar; on launch it
//! stages that binary under `~/.speedy/agent/bin/<version>-<sha8>/` and installs it, unless the
//! running agent is already that build, or is busy (then the swap waits until it's idle).

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use speedy_agent::paths::AgentPaths;

/// `speedy-agent version --json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    pub protocol_min: u32,
    pub protocol_max: u32,
    pub build_sha: String,
}

/// An agent binary: what it reports and the hash of its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Build {
    pub info: VersionInfo,
    pub sha256: String,
}

/// What to do about the installed agent, given the one the app bundles (KTD9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upgrade {
    /// The running agent is this build.
    UpToDate,
    /// Install (and restart into) the bundled build now.
    Install,
    /// Keep using the older, compatible agent; swap once it's idle.
    Pending,
    /// The older agent can't talk to this app, and swapping now would interrupt work.
    Blocked,
}

impl Upgrade {
    /// What a host's header says while the swap waits, if anything.
    pub fn label(self) -> Option<&'static str> {
        match self {
            Upgrade::Pending => Some("pending"),
            Upgrade::Blocked => Some("blocked"),
            Upgrade::UpToDate | Upgrade::Install => None,
        }
    }
}

pub fn decide(installed: Option<&Build>, bundled: &Build, running: bool, busy: bool) -> Upgrade {
    let Some(installed) = installed else { return Upgrade::Install };
    if installed.sha256 == bundled.sha256 {
        return if running { Upgrade::UpToDate } else { Upgrade::Install };
    }
    if !running || !busy {
        return Upgrade::Install;
    }
    let compatible = installed.info.protocol_min.max(bundled.info.protocol_min)
        <= installed.info.protocol_max.min(bundled.info.protocol_max);
    if compatible { Upgrade::Pending } else { Upgrade::Blocked }
}

/// The sidecar next to the app's executable.
pub fn bundled_agent() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let path = exe.parent().map(|d| d.join("speedy-agent")).ok_or_else(|| io::Error::other("no app folder"))?;
    if path.exists() { Ok(path) } else { Err(io::Error::other(format!("{} is missing; run scripts/build-agent.sh", path.display()))) }
}

pub fn current_agent(paths: &AgentPaths) -> PathBuf {
    paths.current_binary()
}

pub fn inspect(binary: &Path) -> io::Result<Build> {
    let out = Command::new(binary).args(["version", "--json"]).output()?;
    if !out.status.success() {
        return Err(io::Error::other(format!("{} version failed", binary.display())));
    }
    let info: VersionInfo = serde_json::from_slice(&out.stdout).map_err(io::Error::other)?;
    Ok(Build { info, sha256: sha256_file(binary)? })
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect())
}

/// Copies `binary` to `bin/<version>-<sha8>/speedy-agent` (once; content-addressed, so a lost
/// race between two apps is harmless) and returns the staged path.
pub fn stage(paths: &AgentPaths, binary: &Path, build: &Build) -> io::Result<PathBuf> {
    let dir = paths.root.join("bin").join(format!("{}-{}", build.info.version, &build.sha256[..8]));
    let staged = dir.join("speedy-agent");
    if staged.exists() && sha256_file(&staged)? == build.sha256 {
        return Ok(staged);
    }
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!(".speedy-agent-{}", std::process::id()));
    std::fs::copy(binary, &tmp)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    std::fs::rename(&tmp, &staged)?;
    Ok(staged)
}

/// Runs the staged binary's `install`, which points `bin/current` at it and (re)starts it.
pub fn install(staged: &Path) -> io::Result<()> {
    let out = Command::new(staged).arg("install").output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(String::from_utf8_lossy(&out.stderr).trim().to_owned()))
    }
}

//! U8: This Mac's agent (KTD9, KTD11). The app bundles `speedy-agent` as a sidecar; on launch it
//! stages that binary under `~/.speedy/agent/bin/<version>-<sha8>/` and installs it, unless the
//! running agent is already that build, is a newer version (never downgraded), or is busy
//! (then the swap waits until it's idle).

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
    /// Unix seconds; 0 for an agent built before this field, or outside `build-agent.sh`.
    #[serde(default)]
    pub build_time: u64,
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
    /// The installed agent is newer than the bundled one but stopped: start it as it is.
    Start,
}

impl Upgrade {
    /// What a host's header says while the swap waits, if anything.
    pub fn label(self) -> Option<&'static str> {
        match self {
            Upgrade::Pending => Some("pending"),
            Upgrade::Blocked => Some("blocked"),
            Upgrade::UpToDate | Upgrade::Install | Upgrade::Start => None,
        }
    }
}

/// Whether two builds share a protocol version.
pub fn compatible(a: &Build, b: &Build) -> bool {
    a.info.protocol_min.max(b.info.protocol_min) <= a.info.protocol_max.min(b.info.protocol_max)
}

/// Orders two agent versions (`MAJOR.MINOR.PATCH[-pre][+build]`): numeric parts compare as
/// numbers, and a pre-release sorts before its release. `None` when either doesn't parse.
pub fn version_cmp(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    fn parse(v: &str) -> Option<(Vec<u64>, Option<&str>)> {
        let v = v.trim().trim_start_matches('v');
        let v = v.split_once('+').map_or(v, |(v, _)| v);
        let (core, pre) = match v.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (v, None),
        };
        let parts = core.split('.').map(|p| p.parse().ok()).collect::<Option<Vec<u64>>>()?;
        if parts.is_empty() { None } else { Some((parts, pre)) }
    }
    let ((mut a, a_pre), (mut b, b_pre)) = (parse(a)?, parse(b)?);
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    Some(a.cmp(&b).then(match (a_pre, b_pre) {
        (None, None) => std::cmp::Ordering::Equal,
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(y),
    }))
}

/// Orders two builds: by version, then by build time within a version. `None` when either
/// version doesn't parse.
pub fn build_cmp(a: &Build, b: &Build) -> Option<std::cmp::Ordering> {
    version_cmp(&a.info.version, &b.info.version).map(|o| o.then(a.info.build_time.cmp(&b.info.build_time)))
}

/// Whether the installed agent is a strictly newer build than the bundled one.
pub fn installed_is_newer(installed: &Build, bundled: &Build) -> bool {
    build_cmp(installed, bundled) == Some(std::cmp::Ordering::Greater)
}

/// The KTD9 rule. The bundled build replaces the installed one only when it is a newer build
/// (version, then build time), or when the installed one can't talk to this app at all. It
/// never replaces a newer compatible agent, so two app builds sharing a host don't take turns
/// reinstalling. Two builds with no ordering between them (same version and build time) leave
/// a running agent be.
pub fn decide(installed: Option<&Build>, bundled: &Build, running: bool, busy: bool) -> Upgrade {
    let Some(installed) = installed else { return Upgrade::Install };
    if installed.sha256 == bundled.sha256 {
        return if running { Upgrade::UpToDate } else { Upgrade::Install };
    }
    let compatible = compatible(installed, bundled);
    let bundled_newer = build_cmp(bundled, installed) == Some(std::cmp::Ordering::Greater);
    if compatible && !bundled_newer {
        return match (running, installed_is_newer(installed, bundled)) {
            (true, _) => Upgrade::UpToDate,
            // Stopped and newer: start it rather than downgrade it.
            (false, true) => Upgrade::Start,
            // Stopped, same version (or unordered): nothing to interrupt, and whichever app
            // starts it next leaves it be.
            (false, false) => Upgrade::Install,
        };
    }
    if !running || !busy {
        return Upgrade::Install;
    }
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

/// What `speedy-agent install` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installed {
    /// This build now runs.
    Started,
    /// The running agent was busy when asked, so it keeps running and nothing was switched.
    Busy,
}

impl Installed {
    /// Reads `install`'s exit status.
    pub fn from_exit(status: std::process::ExitStatus, stderr: &[u8]) -> Result<Installed, String> {
        match status.code() {
            Some(0) => Ok(Installed::Started),
            Some(code) if code == speedy_agent::daemon::EXIT_BUSY => Ok(Installed::Busy),
            _ => Err(String::from_utf8_lossy(stderr).trim().to_owned()),
        }
    }
}

/// What a host shows when the running agent was busy at the swap: an update waiting for it
/// to go idle, or blocked when it can't talk to this app.
pub fn deferred(installed: Option<&Build>, bundled: &Build) -> Upgrade {
    match installed {
        Some(installed) if !compatible(installed, bundled) => Upgrade::Blocked,
        _ => Upgrade::Pending,
    }
}

/// Runs the staged binary's `install`, which (re)starts the agent on it unless the running
/// one is busy: the agent itself decides that and stops taking work in one step (KTD9).
pub fn install(staged: &Path) -> io::Result<Installed> {
    let out = Command::new(staged).arg("install").output()?;
    Installed::from_exit(out.status, &out.stderr).map_err(io::Error::other)
}

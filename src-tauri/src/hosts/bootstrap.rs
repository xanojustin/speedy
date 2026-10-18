//! U11: getting a compatible agent running on an SSH host (KTD9). One probe reports the OS,
//! architecture, the installed agent and whether it runs; the app then uploads its bundled
//! agent (content-addressed, checked by sha256 before it's moved into place) and installs it,
//! or connects to the agent that is already there.

use std::path::Path;

use super::local::{self, Build, VersionInfo};
use super::ssh::{REMOTE_AGENT, Ssh};

const PROBE_MARK: &str = "SPEEDY-PROBE";

/// What the probe found on the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub os: String,
    pub arch: String,
    pub installed: Option<Build>,
    pub running: bool,
}

/// The probe script, fed to `/bin/sh -s`. Fields are NUL-separated after a marker, so
/// whatever the user's shell startup prints first is skipped. `$a` is [`REMOTE_AGENT`].
pub const PROBE: &str = r#"a="$HOME/.speedy/agent/bin/current/speedy-agent"
printf 'SPEEDY-PROBE\0%s\0%s\0' "$(uname -s)" "$(uname -m)"
if [ -x "$a" ]; then
  printf '%s\0' "$("$a" version --json 2>/dev/null)"
  printf '%s\0' "$(shasum -a 256 "$a" | cut -d' ' -f1)"
  "$a" status >/dev/null 2>&1; printf '%s\0' "$?"
else
  printf '\0\0none\0'
fi
"#;

pub fn parse_probe(stdout: &[u8]) -> Result<Probe, String> {
    let text = String::from_utf8_lossy(stdout);
    let start = text.find(PROBE_MARK).ok_or("the host didn't answer the probe")?;
    let fields: Vec<&str> = text[start..].split('\0').collect();
    let field = |i: usize| fields.get(i).copied().unwrap_or("").trim();
    let installed = match (serde_json::from_str::<VersionInfo>(field(3)), field(4)) {
        (Ok(info), sha) if !sha.is_empty() => Some(Build { info, sha256: sha.to_owned() }),
        _ => None,
    };
    Ok(Probe { os: field(1).to_owned(), arch: field(2).to_owned(), installed, running: field(5) == "0" })
}

/// What a connect has to do first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Connect to the agent that's running (a newer bundle waits for it to go idle).
    Connect,
    /// Start the installed agent, which is this build or a newer compatible one.
    Start,
    /// Upload and install the bundled agent.
    Upload,
}

pub fn plan(probe: &Probe, bundled: &Build, bundled_archs: &[String]) -> Result<Step, String> {
    if probe.os != "Darwin" {
        return Err(format!("{} isn't a Mac ({}); Speedy hosts are macOS for now", probe.os, probe.arch));
    }
    let arch = probe.arch.as_str();
    if !bundled_archs.iter().any(|a| a == arch) {
        return Err(format!("this Speedy's agent is built for {} only; the host is {arch}", bundled_archs.join(", ")));
    }
    Ok(match (&probe.installed, probe.running) {
        (_, true) => Step::Connect,
        (Some(installed), false) if installed.sha256 == bundled.sha256 => Step::Start,
        // A newer agent another Speedy installed is never downgraded (KTD9).
        (Some(installed), false) if local::installed_is_newer(installed, bundled) && local::compatible(installed, bundled) => Step::Start,
        _ => Step::Upload,
    })
}

/// Uploads `binary` to `bin/<version>-<sha8>/` on the host, verifies it, and installs it.
pub async fn upload_and_install(ssh: &Ssh, binary: &Path, build: &Build) -> Result<(), String> {
    let dir = format!(".speedy/agent/bin/{}-{}", build.info.version, &build.sha256[..8]);
    run(ssh, &format!("mkdir -p \"$HOME/{dir}\" && chmod 700 \"$HOME/.speedy\" \"$HOME/.speedy/agent\"")).await?;
    ssh.upload(binary, &format!("{dir}/.speedy-agent-upload")).await?;
    let sha = &build.sha256;
    run(
        ssh,
        &format!(
            r#"cd "$HOME/{dir}" || exit 1
if [ "$(shasum -a 256 .speedy-agent-upload | cut -d' ' -f1)" != "{sha}" ]; then rm -f .speedy-agent-upload; echo "the upload was corrupted" >&2; exit 1; fi
chmod 755 .speedy-agent-upload && mv -f .speedy-agent-upload speedy-agent && ./speedy-agent install"#
        ),
    )
    .await
}

/// Restarts the installed agent from `bin/current`.
pub async fn start_installed(ssh: &Ssh) -> Result<(), String> {
    run(ssh, &format!("\"$HOME/{REMOTE_AGENT}\" install")).await
}

pub async fn probe(ssh: &Ssh) -> Result<Probe, String> {
    let out = ssh.sh(PROBE).await?;
    parse_probe(&out.stdout)
}

async fn run(ssh: &Ssh, script: &str) -> Result<(), String> {
    let out = ssh.sh(script).await?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) }
}

/// The architectures the bundled agent runs on (`lipo -archs`), read once.
pub fn bundled_archs(binary: &Path) -> Vec<String> {
    static ARCHS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ARCHS
        .get_or_init(|| {
            std::process::Command::new("/usr/bin/lipo")
                .arg("-archs")
                .arg(binary)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().map(str::to_owned).collect())
                .unwrap_or_default()
        })
        .clone()
}

/// The bundled agent and its build, inspected once: the sidecar can't change while the app runs.
pub fn bundled() -> Result<(std::path::PathBuf, Build), String> {
    static BUNDLED: std::sync::OnceLock<Result<(std::path::PathBuf, Build), String>> = std::sync::OnceLock::new();
    BUNDLED
        .get_or_init(|| {
            let binary = local::bundled_agent().map_err(|e| e.to_string())?;
            let build = local::inspect(&binary).map_err(|e| e.to_string())?;
            Ok((binary, build))
        })
        .clone()
}

//! U2: login-shell environment capture, `claude` discovery, setup state, and the
//! extension's `claudeCode.*` settings (KTD7).

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::watch;

/// The latest CLI version the protocol drift test passed against (KTD7 skew warning).
/// Fixtures were recorded against 2.1.296.
pub const FIXTURE_CLI_VERSION: &str = "2.1.300 (Claude Code)";

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// `claude --version` / `claude auth status` should answer quickly; a wedged CLI
/// must not leave the setup screen spinning forever.
const CLI_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const ENV_START: &str = "__SPEEDY_ENV_START__";
const ENV_END: &str = "__SPEEDY_ENV_END__";

/// Environment captured from `$SHELL -l -i -c env`, used for every child process.
#[derive(Debug, Clone, Default)]
pub struct ResolvedEnv {
    pub vars: HashMap<String, String>,
    /// True when the login shell timed out or failed and the fallback env was used.
    pub degraded: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupStatus {
    Resolving,
    Ready,
    CliNotFound,
    NotLoggedIn,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub status: SetupStatus,
    pub claude_path: Option<String>,
    pub claude_version: Option<String>,
    pub fixture_version: String,
    /// True when the installed CLI version differs at all from `FIXTURE_CLI_VERSION`.
    pub version_mismatch: bool,
    pub searched_paths: Vec<String>,
    pub env_degraded: bool,
    /// Human-readable guidance for the setup screen.
    pub message: Option<String>,
}

/// Where the resolver looks. `EnvPaths::real()` is the user's machine; tests
/// point every path at a tempdir.
#[derive(Debug, Clone)]
pub struct EnvPaths {
    /// Login shell to capture the environment from.
    pub shell: String,
    pub home: PathBuf,
    /// Directory holding `anthropic.claude-code-*` extension folders.
    pub vscode_extensions_dir: PathBuf,
    /// VS Code user `settings.json` (JSONC).
    pub vscode_settings_path: PathBuf,
    pub capture_timeout: Duration,
}

impl EnvPaths {
    pub fn real() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        EnvPaths {
            shell: std::env::var("SHELL")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/bin/zsh".into()),
            vscode_extensions_dir: home.join(".vscode/extensions"),
            vscode_settings_path: home.join("Library/Application Support/Code/User/settings.json"),
            home,
            capture_timeout: CAPTURE_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone)]
struct Resolution {
    env: ResolvedEnv,
    claude_path: Option<PathBuf>,
    setup: SetupState,
}

/// Owns the resolved env and setup state. `start()` kicks off resolution on a
/// background thread; readers block (async) until it's done.
pub struct EnvService {
    tx: Arc<watch::Sender<Option<Arc<Resolution>>>>,
    /// Set by the background thread before it starts resolving.
    settings: Arc<OnceLock<Map<String, Value>>>,
}

impl EnvService {
    pub fn start() -> Self {
        Self::start_with(EnvPaths::real())
    }

    /// `start()` with explicit paths.
    pub fn start_with(paths: EnvPaths) -> Self {
        let (tx, _rx) = watch::channel(None);
        let tx = Arc::new(tx);
        let bg = tx.clone();
        let settings = Arc::new(OnceLock::new());
        let bg_settings = settings.clone();
        std::thread::spawn(move || {
            // First and quick (two small files), so it never waits on the login shell.
            let mut settings = read_extension_settings(&paths.vscode_extensions_dir, &paths.vscode_settings_path);
            settings.extend(read_claude_defaults(&paths.home.join(".claude/settings.json")));
            let _ = bg_settings.set(settings);
            let env = capture_login_env_in(&paths.shell, paths.capture_timeout, &paths.home);
            let res = check_cli(env, None);
            bg.send_replace(Some(Arc::new(res)));
        });
        EnvService { tx, settings }
    }

    async fn resolved(&self) -> Arc<Resolution> {
        let mut rx = self.tx.subscribe();
        let guard = rx
            .wait_for(|r| r.is_some())
            .await
            .expect("EnvService keeps its sender alive");
        guard.clone().expect("checked by wait_for")
    }

    /// Resolved env for child processes (waits for resolution).
    pub async fn env(&self) -> ResolvedEnv {
        self.resolved().await.env.clone()
    }

    /// Resolved `claude` binary path, if found.
    pub async fn claude_path(&self) -> Option<PathBuf> {
        self.resolved().await.claude_path.clone()
    }

    pub async fn setup_state(&self) -> SetupState {
        self.resolved().await.setup.clone()
    }

    /// Re-runs discovery and auth checks (after the user fixes their install).
    /// The captured environment is kept; only the CLI checks run again.
    pub async fn recheck(&self, override_path: Option<PathBuf>) -> SetupState {
        let env = self.resolved().await.env.clone();
        let res = tokio::task::spawn_blocking(move || check_cli(env, override_path.as_deref()))
            .await
            .expect("cli check panicked");
        let setup = res.setup.clone();
        self.tx.send_replace(Some(Arc::new(res)));
        setup
    }

    /// Effective `claudeCode.*` settings: extension defaults overlaid with the
    /// user's VS Code `settings.json`. Keys keep their full `claudeCode.` names.
    /// Read on the background thread before env resolution, so this blocks only if
    /// called within moments of `start()` (and never once `env()` has returned).
    pub fn extension_settings(&self) -> Map<String, Value> {
        self.settings.wait().clone()
    }
}

/// Captures the login-shell environment with a timeout, falling back to the
/// process env plus common paths.
pub fn capture_login_env(shell: &str, timeout: Duration) -> ResolvedEnv {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    capture_login_env_in(shell, timeout, &home)
}

fn capture_login_env_in(shell: &str, timeout: Duration, home: &Path) -> ResolvedEnv {
    // Sentinels plus NUL-separated output keep banners and rc `printf`s out of the env.
    let script = format!("printf '%s' '{ENV_START}'; /usr/bin/env -0; printf '%s' '{ENV_END}'");
    let mut cmd = Command::new(shell);
    cmd.args(["-l", "-i", "-c", &script]);
    match run_with_timeout(cmd, timeout) {
        Some((true, out)) => match parse_env_output(&out) {
            Some(vars) => ResolvedEnv { vars, degraded: false },
            None => fallback_env(home),
        },
        _ => fallback_env(home),
    }
}

fn parse_env_output(out: &[u8]) -> Option<HashMap<String, String>> {
    let start = find(out, ENV_START.as_bytes())? + ENV_START.len();
    let len = find(&out[start..], ENV_END.as_bytes())?;
    let body = &out[start..start + len];
    let vars: HashMap<String, String> = body
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (k, v) = entry.split_once('=')?;
            (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect();
    (!vars.is_empty()).then_some(vars)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn fallback_env(home: &Path) -> ResolvedEnv {
    let mut vars: HashMap<String, String> = std::env::vars().collect();
    let mut path: Vec<String> = vars
        .get("PATH")
        .map(|p| p.split(':').filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    let common = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        home.join(".local/bin").to_string_lossy().into_owned(),
    ];
    for dir in common {
        if !path.contains(&dir) {
            path.push(dir);
        }
    }
    vars.insert("PATH".into(), path.join(":"));
    ResolvedEnv { vars, degraded: true }
}

/// Runs `cmd` in its own session (so it has no controlling terminal and can't be
/// stopped by job control), stdin null, stdout captured. Kills the whole process
/// group on timeout. Returns (exited successfully, stdout), or None on spawn
/// failure or timeout.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<(bool, Vec<u8>)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches no Rust state.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().ok()?;
    let pgid = child.id() as libc::pid_t;
    let mut stdout = child.stdout.take()?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = out_tx.send(buf);
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        // setsid made the child its own session/group leader, so pgid == pid.
        crate::proc_group::signal_group(pgid, libc::SIGKILL);
        let _ = child.wait();
        return None;
    };
    // A background grandchild may still hold stdout open; don't wait on it forever.
    let out = out_rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
    Some((status.success(), out))
}

fn is_executable_file(p: &Path) -> bool {
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn check_cli(env: ResolvedEnv, override_path: Option<&Path>) -> Resolution {
    let mut setup = SetupState {
        status: SetupStatus::Ready,
        claude_path: None,
        claude_version: None,
        fixture_version: FIXTURE_CLI_VERSION.into(),
        version_mismatch: false,
        searched_paths: vec![],
        env_degraded: env.degraded,
        message: None,
    };

    let candidates: Vec<PathBuf> = match override_path {
        // The override comes from the webview, so it may only name a binary called `claude`;
        // anything else would let the page run an arbitrary program via `--version`.
        Some(p) if p.file_name().is_some_and(|n| n == "claude") => vec![p.to_path_buf()],
        Some(_) => vec![],
        None => env
            .vars
            .get("PATH")
            .map(|p| p.split(':').filter(|s| !s.is_empty()).map(|d| Path::new(d).join("claude")).collect())
            .unwrap_or_default(),
    };
    let claude_path = candidates.iter().find(|p| is_executable_file(p)).cloned();
    let Some(claude) = claude_path else {
        setup.status = SetupStatus::CliNotFound;
        setup.searched_paths = match override_path {
            Some(p) => vec![p.to_string_lossy().into_owned()],
            None => candidates
                .iter()
                .filter_map(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
                .collect(),
        };
        setup.message = Some(match override_path {
            Some(p) => format!(
                "No executable `claude` at {}. Choose the path of a binary named `claude`.",
                p.display()
            ),
            None => "Couldn't find the `claude` CLI on your login shell's PATH. Install Claude Code \
                     (https://docs.anthropic.com/claude-code) or choose its location."
                .into(),
        });
        return Resolution { env, claude_path: None, setup };
    };
    setup.claude_path = Some(claude.to_string_lossy().into_owned());

    let run = |args: &[&str]| {
        let mut cmd = Command::new(&claude);
        cmd.args(args).env_clear().envs(&env.vars);
        run_with_timeout(cmd, CLI_CHECK_TIMEOUT)
    };

    match run(&["--version"]) {
        Some((true, out)) => {
            let version = String::from_utf8_lossy(&out).trim().to_string();
            setup.version_mismatch = version != FIXTURE_CLI_VERSION;
            setup.claude_version = Some(version);
        }
        _ => {
            setup.status = SetupStatus::Error;
            setup.message = Some(format!("`{} --version` failed or timed out.", claude.display()));
            return Resolution { env, claude_path: Some(claude), setup };
        }
    }

    // `claude auth status` prints JSON. Only `loggedIn` is read; account fields are
    // never kept. Output we can't parse doesn't block: the chat surfaces auth errors.
    if let Some((_, out)) = run(&["auth", "status"]) {
        let logged_in = serde_json::from_slice::<Value>(&out)
            .ok()
            .and_then(|v| v.get("loggedIn").and_then(Value::as_bool));
        if logged_in == Some(false) {
            setup.status = SetupStatus::NotLoggedIn;
            setup.message =
                Some("Claude Code isn't logged in. Run `claude auth login` in the terminal, then recheck.".into());
        }
    }

    Resolution { env, claude_path: Some(claude), setup }
}

// ---- extension settings ----

fn builtin_defaults() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("claudeCode.useCtrlEnterToSend".into(), Value::Bool(false));
    m.insert("claudeCode.respectGitIgnore".into(), Value::Bool(true));
    m.insert("claudeCode.allowDangerouslySkipPermissions".into(), Value::Bool(false));
    m.insert("claudeCode.initialPermissionMode".into(), Value::String("default".into()));
    m.insert("claudeCode.showMessageTimestamps".into(), Value::Bool(false));
    m
}

fn read_extension_settings(extensions_dir: &Path, settings_path: &Path) -> Map<String, Value> {
    let mut out = builtin_defaults();
    if let Some(pkg) = newest_extension_dir(extensions_dir)
        .and_then(|d| std::fs::read(d.join("package.json")).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    {
        let configs = match pkg.pointer("/contributes/configuration") {
            Some(Value::Array(a)) => a.clone(),
            Some(v @ Value::Object(_)) => vec![v.clone()],
            _ => vec![],
        };
        for cfg in configs {
            if let Some(Value::Object(props)) = cfg.get("properties") {
                for (k, prop) in props {
                    if !k.starts_with("claudeCode.") {
                        continue;
                    }
                    match prop.get("default") {
                        Some(v) if !v.is_null() => {
                            out.insert(k.clone(), v.clone());
                        }
                        _ => {
                            out.entry(k.clone()).or_insert(Value::Null);
                        }
                    }
                }
            }
        }
    }
    if let Some(Value::Object(user)) = std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&strip_jsonc(&s)).ok())
    {
        for (k, v) in user {
            if k.starts_with("claudeCode.") {
                out.insert(k, v);
            }
        }
    }
    out
}

/// The user's global Claude Code defaults (`~/.claude/settings.json`), under `claude.*` keys:
/// `claude.model`, `claude.effortLevel`, and `claude.defaultMode` (from `permissions.defaultMode`).
/// The CLI applies these itself; the UI reads them to show what a new thread will use.
pub fn read_claude_defaults(settings_path: &Path) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(s) = std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&strip_jsonc(&s)).ok())
    else {
        return out;
    };
    for (key, pointer) in [("claude.model", "/model"), ("claude.effortLevel", "/effortLevel"), ("claude.defaultMode", "/permissions/defaultMode")] {
        if let Some(v) = s.pointer(pointer).filter(|v| v.is_string()) {
            out.insert(key.into(), v.clone());
        }
    }
    out
}

fn newest_extension_dir(extensions_dir: &Path) -> Option<PathBuf> {
    const PREFIX: &str = "anthropic.claude-code-";
    std::fs::read_dir(extensions_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix(PREFIX)?;
            let version: Vec<u64> = rest.split('-').next()?.split('.').map(|n| n.parse().ok()).collect::<Option<_>>()?;
            Some((version, e.path()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, p)| p)
}

/// Removes `//` and `/* */` comments outside strings and trailing commas
/// before `}` / `]`, turning VS Code's JSONC into plain JSON.
fn strip_jsonc(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let mut in_str = false;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match (c, chars.get(i + 1)) {
            ('"', _) => {
                in_str = true;
                out.push(c);
                i += 1;
            }
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
            }
            (',', _) => {
                // Drop the comma if only whitespace/comments separate it from a closer.
                let mut j = i + 1;
                loop {
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if chars.get(j) == Some(&'/') && chars.get(j + 1) == Some(&'/') {
                        while j < chars.len() && chars[j] != '\n' {
                            j += 1;
                        }
                    } else if chars.get(j) == Some(&'/') && chars.get(j + 1) == Some(&'*') {
                        j += 2;
                        while j < chars.len() && !(chars[j] == '*' && chars.get(j + 1) == Some(&'/')) {
                            j += 1;
                        }
                        j += 2;
                    } else {
                        break;
                    }
                }
                if !matches!(chars.get(j), Some('}') | Some(']')) {
                    out.push(',');
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

#[tauri::command]
pub async fn get_setup_state(ctx: tauri::State<'_, crate::AppCtx>) -> Result<SetupState, String> {
    Ok(ctx.env.setup_state().await)
}

#[tauri::command]
pub async fn recheck_setup(
    ctx: tauri::State<'_, crate::AppCtx>,
    override_path: Option<String>,
) -> Result<SetupState, String> {
    Ok(ctx.env.recheck(override_path.map(PathBuf::from)).await)
}

#[tauri::command]
pub fn get_extension_settings(ctx: tauri::State<'_, crate::AppCtx>) -> Map<String, Value> {
    ctx.env.extension_settings()
}

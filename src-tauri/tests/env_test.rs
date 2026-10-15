//! U2: environment resolver, CLI discovery, setup state, extension settings.
//! Every external program here is a fake shell script written into a tempdir.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;
use speedy_lib::env::{capture_login_env, EnvPaths, EnvService, SetupStatus, FIXTURE_CLI_VERSION};

fn write_exe(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A fake login shell: prints rc noise, sets PATH, runs the `-c` command
/// (`$4` after `-l -i -c`), then prints more noise.
fn fake_shell(dir: &Path, path_value: &str) -> PathBuf {
    let shell = dir.join("fake-zsh");
    write_exe(
        &shell,
        &format!(
            "#!/bin/sh\n\
             echo 'Welcome to your shell! Last login: today'\n\
             printf 'motd line without newline'\n\
             export PATH='{path_value}'\n\
             export SPEEDY_TEST_VAR='hello world=with equals'\n\
             /bin/sh -c \"$4\"\n\
             echo 'goodbye banner'\n"
        ),
    );
    shell
}

fn fake_claude(bin_dir: &Path, version: &str, auth_json: &str) -> PathBuf {
    let claude = bin_dir.join("claude");
    write_exe(
        &claude,
        &format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo '{version}'; exit 0; fi\n\
             if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then echo '{auth_json}'; exit 0; fi\n\
             exit 1\n"
        ),
    );
    claude
}

const LOGGED_IN: &str = r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "x@example.com"}"#;

fn paths(dir: &Path, shell: &Path) -> EnvPaths {
    EnvPaths {
        shell: shell.to_string_lossy().into_owned(),
        home: dir.join("home"),
        vscode_extensions_dir: dir.join("home/.vscode/extensions"),
        vscode_settings_path: dir.join("home/settings.json"),
        capture_timeout: Duration::from_secs(5),
    }
}

#[tokio::test]
async fn login_shell_path_with_nvm_dir_finds_claude_there() {
    let dir = tempfile::tempdir().unwrap();
    let nvm_bin = dir.path().join(".nvm/versions/node/v24.14.0/bin");
    let claude = fake_claude(&nvm_bin, FIXTURE_CLI_VERSION, LOGGED_IN);
    let shell = fake_shell(dir.path(), &format!("{}:/usr/bin:/bin", nvm_bin.display()));

    let svc = EnvService::start_with(paths(dir.path(), &shell));
    let env = svc.env().await;
    assert!(!env.degraded);
    assert!(env.vars["PATH"].split(':').any(|p| Path::new(p) == nvm_bin));
    assert_eq!(svc.claude_path().await, Some(claude.clone()));

    let state = svc.setup_state().await;
    assert_eq!(state.status, SetupStatus::Ready);
    assert_eq!(state.claude_path.as_deref(), Some(claude.to_str().unwrap()));
    assert_eq!(state.claude_version.as_deref(), Some(FIXTURE_CLI_VERSION));
    assert!(!state.version_mismatch);
    assert!(!state.env_degraded);
}

#[test]
fn rc_noise_does_not_corrupt_parsed_env() {
    let dir = tempfile::tempdir().unwrap();
    let shell = fake_shell(dir.path(), "/custom/bin:/usr/bin:/bin");
    let env = capture_login_env(shell.to_str().unwrap(), Duration::from_secs(5));
    assert!(!env.degraded);
    assert_eq!(env.vars["PATH"], "/custom/bin:/usr/bin:/bin");
    assert_eq!(env.vars["SPEEDY_TEST_VAR"], "hello world=with equals");
    for (k, v) in &env.vars {
        assert!(!k.contains("Welcome") && !k.contains("motd") && !k.contains("goodbye"), "noise key {k}");
        assert!(!v.contains("goodbye banner") && !v.contains("Welcome"), "noise in {k}={v}");
    }
}

#[test]
fn hanging_shell_times_out_into_degraded_fallback_env() {
    let dir = tempfile::tempdir().unwrap();
    let shell = dir.path().join("hang-zsh");
    write_exe(&shell, "#!/bin/sh\nsleep 30\n");

    let started = Instant::now();
    let env = capture_login_env(shell.to_str().unwrap(), Duration::from_millis(300));
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    assert!(env.degraded);
    let path = &env.vars["PATH"];
    assert!(path.split(':').any(|p| p == "/opt/homebrew/bin"), "PATH={path}");
    assert!(path.split(':').any(|p| p == "/usr/local/bin"), "PATH={path}");
    assert!(path.split(':').any(|p| p.ends_with("/.local/bin")), "PATH={path}");
    // The rest of the process env is kept.
    assert_eq!(env.vars.get("HOME"), std::env::var("HOME").ok().as_ref());
}

#[tokio::test]
async fn missing_claude_without_override_is_cli_not_found_with_searched_paths() {
    let dir = tempfile::tempdir().unwrap();
    let empty_a = dir.path().join("a/bin");
    let empty_b = dir.path().join("b/bin");
    std::fs::create_dir_all(&empty_a).unwrap();
    std::fs::create_dir_all(&empty_b).unwrap();
    let shell = fake_shell(dir.path(), &format!("{}:{}", empty_a.display(), empty_b.display()));

    let svc = EnvService::start_with(paths(dir.path(), &shell));
    let state = svc.setup_state().await;
    assert_eq!(state.status, SetupStatus::CliNotFound);
    assert_eq!(
        state.searched_paths,
        vec![empty_a.to_string_lossy().into_owned(), empty_b.to_string_lossy().into_owned()]
    );
    assert!(state.message.is_some());
    assert_eq!(svc.claude_path().await, None);
}

#[tokio::test]
async fn recheck_with_override_path_wins_over_path() {
    let dir = tempfile::tempdir().unwrap();
    let on_path = dir.path().join("onpath/bin");
    fake_claude(&on_path, FIXTURE_CLI_VERSION, LOGGED_IN);
    let custom = fake_claude(&dir.path().join("custom"), FIXTURE_CLI_VERSION, LOGGED_IN);
    let shell = fake_shell(dir.path(), &format!("{}:/usr/bin:/bin", on_path.display()));

    let svc = EnvService::start_with(paths(dir.path(), &shell));
    let state = svc.recheck(Some(custom.clone())).await;
    assert_eq!(state.status, SetupStatus::Ready);
    assert_eq!(state.claude_path.as_deref(), Some(custom.to_str().unwrap()));
    assert_eq!(svc.claude_path().await, Some(custom));
}

#[tokio::test]
async fn logged_out_auth_status_is_not_logged_in_with_login_hint() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fake_claude(&bin, FIXTURE_CLI_VERSION, r#"{"loggedIn": false, "authMethod": "none"}"#);
    let shell = fake_shell(dir.path(), &format!("{}:/usr/bin:/bin", bin.display()));

    let state = EnvService::start_with(paths(dir.path(), &shell)).setup_state().await;
    assert_eq!(state.status, SetupStatus::NotLoggedIn);
    assert!(state.message.unwrap().contains("claude auth login"));
}

#[tokio::test]
async fn unparseable_auth_status_does_not_block() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fake_claude(&bin, FIXTURE_CLI_VERSION, "Logged in as someone");
    let shell = fake_shell(dir.path(), &format!("{}:/usr/bin:/bin", bin.display()));

    let state = EnvService::start_with(paths(dir.path(), &shell)).setup_state().await;
    assert_eq!(state.status, SetupStatus::Ready);
}

#[tokio::test]
async fn different_cli_version_sets_version_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fake_claude(&bin, "2.1.297 (Claude Code)", LOGGED_IN);
    let shell = fake_shell(dir.path(), &format!("{}:/usr/bin:/bin", bin.display()));

    let state = EnvService::start_with(paths(dir.path(), &shell)).setup_state().await;
    assert_eq!(state.status, SetupStatus::Ready);
    assert_eq!(state.claude_version.as_deref(), Some("2.1.297 (Claude Code)"));
    assert!(state.version_mismatch);
}

fn write_extension(ext_dir: &Path, version: &str, use_ctrl_enter_default: bool) {
    let pkg = serde_json::json!({
        "name": "claude-code",
        "contributes": { "configuration": [{
            "title": "Claude Code",
            "properties": {
                "claudeCode.useCtrlEnterToSend": { "type": "boolean", "default": use_ctrl_enter_default },
                "claudeCode.respectGitIgnore": { "type": "boolean", "default": true },
                "claudeCode.allowDangerouslySkipPermissions": { "type": "boolean", "default": null },
                "claudeCode.spinnerVerbs": { "type": "object", "default": { "mode": "append", "verbs": [] } }
            }
        }]}
    });
    let dir = ext_dir.join(format!("anthropic.claude-code-{version}-darwin-arm64"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("package.json"), serde_json::to_vec(&pkg).unwrap()).unwrap();
}

#[test]
fn jsonc_user_settings_overlay_newest_extension_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let shell = fake_shell(dir.path(), "/usr/bin:/bin");
    let p = paths(dir.path(), &shell);
    // 2.1.10 is newer than 2.1.9 numerically; its default (false) must win over 2.1.9's (true).
    write_extension(&p.vscode_extensions_dir, "2.1.9", true);
    write_extension(&p.vscode_extensions_dir, "2.1.10", false);
    std::fs::write(
        &p.vscode_settings_path,
        r#"{
  // keyboard
  "claudeCode.useCtrlEnterToSend": true,
  /* model picked in the panel */
  "claudeCode.selectedModel": "opus",
  "editor.fontSize": 13, // not ours
  "workbench.colorTheme": "Dark // not a comment",
}
"#,
    )
    .unwrap();

    let settings = EnvService::start_with(p).extension_settings();
    assert_eq!(settings["claudeCode.useCtrlEnterToSend"], Value::Bool(true));
    assert_eq!(settings["claudeCode.selectedModel"], Value::String("opus".into()));
    assert_eq!(settings["claudeCode.respectGitIgnore"], Value::Bool(true));
    // Extension default of null falls back to the built-in default.
    assert_eq!(settings["claudeCode.allowDangerouslySkipPermissions"], Value::Bool(false));
    assert_eq!(settings["claudeCode.spinnerVerbs"]["mode"], Value::String("append".into()));
    assert!(!settings.contains_key("editor.fontSize"));
}

#[test]
fn no_settings_files_use_builtin_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let shell = fake_shell(dir.path(), "/usr/bin:/bin");
    let settings = EnvService::start_with(paths(dir.path(), &shell)).extension_settings();
    assert_eq!(settings["claudeCode.useCtrlEnterToSend"], Value::Bool(false));
    assert_eq!(settings["claudeCode.respectGitIgnore"], Value::Bool(true));
    assert_eq!(settings["claudeCode.allowDangerouslySkipPermissions"], Value::Bool(false));
    assert_eq!(settings["claudeCode.initialPermissionMode"], Value::String("default".into()));
    assert_eq!(settings["claudeCode.showMessageTimestamps"], Value::Bool(false));
}

#[tokio::test]
async fn override_not_named_claude_is_refused_without_running_it() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let evil = dir.path().join("evil");
    std::fs::write(&evil, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
    std::fs::set_permissions(&evil, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let shell = fake_shell(dir.path(), "/usr/bin:/bin");

    let state = EnvService::start_with(paths(dir.path(), &shell)).recheck(Some(evil)).await;
    assert_eq!(state.status, SetupStatus::CliNotFound);
    assert!(!marker.exists(), "override binary must not be executed");
}

#[test]
fn global_claude_defaults_are_read_from_claude_settings() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("settings.json");
    std::fs::write(&p, r#"{"model":"claude-opus-5-5","effortLevel":"medium","permissions":{"defaultMode":"auto","allow":[]}}"#).unwrap();
    let m = speedy_lib::env::read_claude_defaults(&p);
    assert_eq!(m["claude.model"], "claude-opus-5-5");
    assert_eq!(m["claude.effortLevel"], "medium");
    assert_eq!(m["claude.defaultMode"], "auto");
    assert!(speedy_lib::env::read_claude_defaults(&dir.path().join("missing.json")).is_empty());
}

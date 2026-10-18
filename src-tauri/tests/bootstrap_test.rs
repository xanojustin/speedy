//! U11: reading the host probe and choosing the first step of a connect (KTD9).

use speedy_lib::hosts::bootstrap::{PROBE, Step, parse_probe, plan};
use speedy_lib::hosts::local::{Build, Installed, Upgrade, VersionInfo, deferred};

fn build(sha: &str) -> Build {
    Build { info: VersionInfo { version: "0.1.0".into(), protocol_min: 1, protocol_max: 1, build_sha: "abc".into(), build_time: 0 }, sha256: sha.into() }
}

fn run_probe(home: &std::path::Path) -> Vec<u8> {
    let out = std::process::Command::new("/bin/sh")
        .arg("-s")
        .env("HOME", home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(PROBE.as_bytes())?;
            child.wait_with_output()
        })
        .unwrap();
    out.stdout
}

#[test]
fn the_probe_skips_shell_noise_and_reads_a_host_with_no_agent() {
    let dir = tempfile::tempdir().unwrap();
    let mut out = b"Last login: Sun Oct 18\nWelcome to the mini\n".to_vec();
    out.extend(run_probe(dir.path()));
    let probe = parse_probe(&out).unwrap();
    assert_eq!(probe.os, "Darwin");
    assert!(!probe.arch.is_empty());
    assert_eq!(probe.installed, None);
    assert!(!probe.running);
}

#[test]
fn the_probe_reads_an_installed_agent_and_whether_it_runs() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join(".speedy/agent/bin/current");
    std::fs::create_dir_all(&bin).unwrap();
    let agent = bin.join("speedy-agent");
    let script = r#"#!/bin/sh
case "$1" in
  version) echo '{"version":"0.0.9","protocolMin":1,"protocolMax":1,"buildSha":"old"}' ;;
  status) exit 0 ;;
esac
"#;
    std::fs::write(&agent, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
    let probe = parse_probe(&run_probe(dir.path())).unwrap();
    let installed = probe.installed.expect("installed");
    assert_eq!(installed.info.version, "0.0.9");
    assert_eq!(installed.sha256.len(), 64);
    assert!(probe.running);
}

#[test]
fn the_first_step_depends_on_what_the_host_has() {
    let archs = vec!["arm64".to_string()];
    let probe = |installed: Option<Build>, running: bool| speedy_lib::hosts::bootstrap::Probe {
        os: "Darwin".into(),
        arch: "arm64".into(),
        installed,
        running,
    };
    let bundled = build("new");
    assert_eq!(plan(&probe(None, false), &bundled, &archs), Ok(Step::Upload));
    assert_eq!(plan(&probe(Some(build("new")), false), &bundled, &archs), Ok(Step::Start));
    assert_eq!(plan(&probe(Some(build("old")), false), &bundled, &archs), Ok(Step::Upload));
    assert_eq!(plan(&probe(Some(build("old")), true), &bundled, &archs), Ok(Step::Connect), "a running agent is never replaced at connect");
    let mut newer = build("newer");
    newer.info.version = "0.2.0".into();
    assert_eq!(plan(&probe(Some(newer), false), &bundled, &archs), Ok(Step::Start), "a stopped newer agent is started, not downgraded");
    let linux = speedy_lib::hosts::bootstrap::Probe { os: "Linux".into(), arch: "x86_64".into(), installed: None, running: false };
    assert!(plan(&linux, &bundled, &archs).unwrap_err().contains("isn't a Mac"));
    let intel = speedy_lib::hosts::bootstrap::Probe { os: "Darwin".into(), arch: "x86_64".into(), installed: None, running: false };
    assert!(plan(&intel, &bundled, &archs).unwrap_err().contains("built for arm64 only"));
}

#[test]
fn an_agent_busy_at_the_swap_leaves_the_update_waiting() {
    let exit = |code: i32| {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code << 8)
    };
    assert_eq!(Installed::from_exit(exit(0), b""), Ok(Installed::Started));
    assert_eq!(Installed::from_exit(exit(speedy_agent::daemon::EXIT_BUSY), b""), Ok(Installed::Busy));
    assert_eq!(Installed::from_exit(exit(1), b"disk full\n"), Err("disk full".to_owned()));

    let mut old = build("old");
    assert_eq!(deferred(Some(&old), &build("new")), Upgrade::Pending, "compatible: keep using it");
    old.info.protocol_max = 0;
    old.info.protocol_min = 0;
    assert_eq!(deferred(Some(&old), &build("new")), Upgrade::Blocked, "incompatible: blocked until idle");
}

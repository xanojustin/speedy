//! U11: listing addable hosts from ssh config files.

use speedy_lib::hosts::ssh_config::aliases;

#[test]
fn lists_concrete_aliases_through_includes_and_skips_patterns() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join(".ssh");
    std::fs::create_dir_all(ssh.join("config.d")).unwrap();
    std::fs::write(
        ssh.join("config"),
        "Include config.d/*\n\nHost *\n  ServerAliveInterval 30\n\nHost mac-mini mini # two names\n  HostName mac-mini.tail1234.ts.net\n\nHost=bastion\nHost *.internal !secret\nmatch host foo\n",
    )
    .unwrap();
    std::fs::write(ssh.join("config.d/10-work"), "Host build-box\n  ProxyJump bastion\nHost mac-mini\n").unwrap();
    std::fs::write(ssh.join("config.d/20-lab"), "host LAB-1 lab-?\n").unwrap();

    assert_eq!(aliases(&ssh.join("config")), ["build-box", "mac-mini", "LAB-1", "mini", "bastion"]);
}

#[test]
fn a_missing_config_has_no_hosts() {
    let dir = tempfile::tempdir().unwrap();
    assert!(aliases(&dir.path().join(".ssh/config")).is_empty());
}

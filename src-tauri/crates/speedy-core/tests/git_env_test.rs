//! KTD12: git run by the explorer and worktrees uses the resolved login env, not the
//! process PATH (minimal under launchd or ssh). Its own test binary, because the
//! installed env is process-wide.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;

use speedy_core::env::install_command_env;
use speedy_core::explorer::git_branch;

#[test]
fn explorer_git_resolves_against_the_installed_login_path() {
    let bin = tempfile::tempdir().unwrap();
    let fake = bin.path().join("git");
    // Stands in for a git that only the login PATH knows about (e.g. Homebrew's).
    std::fs::write(&fake, "#!/bin/sh\necho login-path-git\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

    let path = format!("{}:/usr/bin:/bin", bin.path().display());
    install_command_env(HashMap::from([("PATH".to_string(), path)]));

    let project = tempfile::tempdir().unwrap();
    assert_eq!(git_branch(project.path()).as_deref(), Some("login-path-git"));
}

//! U11: the hosts a user can add (R1): concrete `Host` aliases from `~/.ssh/config` and the
//! files it `Include`s. Patterns (`*`, `?`, `!`) aren't hosts. Each alias's real settings
//! (HostName, User, ProxyJump, IdentityAgent, …) are left to `ssh` itself, which resolves them.

use std::path::{Path, PathBuf};

/// Concrete aliases in file order, without duplicates.
pub fn aliases(config: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let ssh_dir = config.parent().map(Path::to_path_buf).unwrap_or_default();
    collect(config, &ssh_dir, &mut out, 0);
    out
}

pub fn user_config() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh/config")
}

fn collect(file: &Path, ssh_dir: &Path, out: &mut Vec<String>, depth: u8) {
    // ssh itself caps nesting; this keeps an include cycle from recursing forever.
    if depth > 8 {
        return;
    }
    let Ok(text) = std::fs::read_to_string(file) else { return };
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let (key, rest) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, r)) => (k, r.trim_start_matches(|c: char| c.is_whitespace() || c == '=')),
            None => continue,
        };
        if key.eq_ignore_ascii_case("host") {
            for name in rest.split_whitespace() {
                let concrete = !name.contains(['*', '?', '!']);
                if concrete && !out.iter().any(|n| n == name) {
                    out.push(name.to_owned());
                }
            }
        } else if key.eq_ignore_ascii_case("include") {
            for pattern in rest.split_whitespace() {
                for path in expand(pattern, ssh_dir) {
                    collect(&path, ssh_dir, out, depth + 1);
                }
            }
        }
    }
}

/// An `Include` argument: `~/` is the home dir, a relative path is under `~/.ssh`, and a
/// trailing `*` in the file name matches files in that folder, in sorted order like ssh.
fn expand(pattern: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let path = match pattern.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None if Path::new(pattern).is_absolute() => PathBuf::from(pattern),
        None => ssh_dir.join(pattern),
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let Some(prefix) = name.strip_suffix('*') else { return vec![path] };
    let Some(dir) = path.parent() else { return vec![] };
    let mut matches: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(prefix)))
        .collect();
    matches.sort();
    matches
}

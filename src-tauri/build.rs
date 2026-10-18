fn main() {
    ensure_agent_sidecar();
    tauri_build::build()
}

/// Tauri refuses to build without the `speedy-agent` sidecar, which `scripts/build-agent.sh`
/// makes (the app's dev and build commands run it first). For a plain `cargo build` or
/// `cargo test`, stand in a stub that fails loudly if anything tries to run it.
fn ensure_agent_sidecar() {
    let triple = std::env::var("TARGET").expect("cargo sets TARGET");
    let path = std::path::Path::new("binaries").join(format!("speedy-agent-{triple}"));
    if path.exists() {
        return;
    }
    println!("cargo:warning=no speedy-agent sidecar; using a stub (run scripts/build-agent.sh for a real one)");
    std::fs::create_dir_all("binaries").expect("create binaries/");
    std::fs::write(&path, "#!/bin/sh\necho 'speedy-agent stub: run scripts/build-agent.sh' >&2\nexit 1\n").expect("write stub");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod stub");
}

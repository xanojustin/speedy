//! `speedy .`: a shell command that opens folders in Speedy, like VS Code's `code .`.
//! The script hands folders to LaunchServices (`open -b`), which delivers them to the app as
//! `RunEvent::Opened` whether Speedy is running or not. Folders queue here until the webview
//! drains them with `open_folders_take`, so a cold launch doesn't lose them.

use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// App event telling the webview there are folders to take.
pub const OPEN_FOLDERS_EVENT: &str = "open-folders";

/// Where the menu item installs the command.
const INSTALL_PATH: &str = "/usr/local/bin/speedy";

const SCRIPT: &str = include_str!("../resources/speedy.sh");

/// Folders received from the OS that the webview hasn't taken yet.
#[derive(Default)]
pub struct PendingOpens(Mutex<Vec<String>>);

/// Queues the opened folders, tells the webview, and brings the window forward.
pub fn handle_opened(app: &AppHandle, urls: &[Url]) {
    let folders: Vec<String> = urls.iter().filter_map(folder_path).collect();
    if folders.is_empty() {
        return;
    }
    app.state::<PendingOpens>()
        .0
        .lock()
        .unwrap()
        .extend(folders);
    // Before the webview listens this is dropped; it drains the queue once it mounts.
    let _ = app.emit(OPEN_FOLDERS_EVENT, ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// A `file://` URL that names an existing directory, as a path without a trailing slash.
fn folder_path(url: &Url) -> Option<String> {
    let path = url.to_file_path().ok()?;
    if !path.is_dir() {
        return None;
    }
    let s = path.to_str()?.trim_end_matches('/');
    Some(if s.is_empty() { "/".into() } else { s.into() })
}

#[tauri::command]
pub fn open_folders_take(pending: tauri::State<'_, PendingOpens>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

/// Menu action: writes the `speedy` script to /usr/local/bin, asking for an admin
/// password when that directory isn't writable. Reports the result in a dialog.
pub fn install_command(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let (kind, msg) = match install(Path::new(INSTALL_PATH)) {
            Ok(()) => (
                MessageDialogKind::Info,
                format!(
                    "Installed {INSTALL_PATH}. Run `speedy .` in a terminal to open the current folder."
                ),
            ),
            Err(err) => (
                MessageDialogKind::Error,
                format!("Couldn't install {INSTALL_PATH}: {err}"),
            ),
        };
        app.dialog()
            .message(msg)
            .title("Shell Command")
            .kind(kind)
            .show(|_| {});
    });
}

fn install(target: &Path) -> Result<(), String> {
    match write_script(target) {
        Ok(()) => return Ok(()),
        Err(err)
            if err.kind() == std::io::ErrorKind::PermissionDenied
                || err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.to_string()),
    }
    // Stage the script, then copy it into place as root.
    let staged = std::env::temp_dir().join(format!("speedy-cli-{}", std::process::id()));
    write_script(&staged).map_err(|e| e.to_string())?;
    let dir = target.parent().unwrap_or(Path::new("/"));
    let shell = format!(
        "mkdir -p {} && install -m 0755 {} {}",
        sh_quote(dir),
        sh_quote(&staged),
        sh_quote(target)
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        shell.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output();
    let _ = std::fs::remove_file(&staged);
    let out = out.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // -128: the user cancelled the password prompt.
        Err(if stderr.contains("-128") {
            "cancelled".into()
        } else {
            stderr.trim().to_string()
        })
    }
}

fn write_script(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, SCRIPT)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opened_urls_keep_only_existing_folders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "").unwrap();
        let dir_url = Url::from_directory_path(dir.path()).unwrap();
        assert!(dir_url.as_str().ends_with('/'));
        assert_eq!(folder_path(&dir_url).as_deref(), dir.path().to_str());
        assert_eq!(folder_path(&Url::from_file_path(&file).unwrap()), None);
        assert_eq!(
            folder_path(&Url::parse("file:///no/such/dir/").unwrap()),
            None
        );
        assert_eq!(
            folder_path(&Url::parse("https://example.com/").unwrap()),
            None
        );
        assert_eq!(
            folder_path(&Url::parse("file:///").unwrap()).as_deref(),
            Some("/")
        );
    }

    #[test]
    fn install_writes_an_executable_script() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("speedy");
        install(&target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), SCRIPT);
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn shell_quoting_survives_single_quotes() {
        assert_eq!(sh_quote(Path::new("/tmp/it's")), r"'/tmp/it'\''s'");
    }

    #[test]
    fn script_resolves_folders_and_rejects_others() {
        // Swap `open` for an echo so the test sees what would be handed to LaunchServices.
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let fake_open = bin.join("open");
        std::fs::write(&fake_open, "#!/bin/sh\necho \"$@\"\n").unwrap();
        write_script(&fake_open.with_file_name("speedy")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_open, std::fs::Permissions::from_mode(0o755)).unwrap();
        let project = std::fs::canonicalize(dir.path()).unwrap().join("my proj");
        std::fs::create_dir(&project).unwrap();

        let run = |args: &[&str]| {
            std::process::Command::new(bin.join("speedy"))
                .args(args)
                .current_dir(&project)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .output()
                .unwrap()
        };
        let out = run(&[]);
        assert!(out.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            format!("-b dev.brecht.speedy {}", project.display())
        );

        let out = run(&["..", "."]);
        let parent = project.parent().unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            format!(
                "-b dev.brecht.speedy {} {}",
                parent.display(),
                project.display()
            )
        );

        let out = run(&["missing"]);
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(String::from_utf8_lossy(&out.stderr).contains("not a folder: missing"));
    }
}

//! U5: versioned, atomically written app state with debounced saves.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::{Condvar, Mutex};

use serde::{Deserialize, Serialize};

pub const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub version: u32,
    pub projects: Vec<Project>,
    /// Sidebar sections that projects can be filed under, in display order.
    pub groups: Vec<Group>,
    pub selected_thread_id: Option<String>,
    pub claude_path_override: Option<String>,
    pub sidebar_width: f64,
    /// Post a system notification when a hidden thread finishes or needs input.
    pub notifications_enabled: bool,
    /// System sound played when a thread needs attention; None = silent.
    pub completion_sound: Option<String>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            version: STATE_VERSION,
            projects: vec![],
            groups: vec![],
            selected_thread_id: None,
            claude_path_override: None,
            sidebar_width: 260.0,
            notifications_enabled: true,
            completion_sound: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    pub collapsed: bool,
    /// The group this project is filed under; None (or an unknown id) = ungrouped.
    pub group_id: Option<String>,
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    /// A theme chart color name (blue, green, …); None is filled in by the webview.
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Thread {
    pub id: String,
    pub title: String,
    /// The CLI session this thread is bound to (one thread ↔ one session).
    pub session_id: Option<String>,
    pub archived: bool,
    pub created_at: u64,
    /// Chat share of the chat/terminal split, 0..1.
    pub split_ratio: f64,
    pub terminal_visible: bool,
    pub terminal_maximized: bool,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
}

impl Default for Thread {
    fn default() -> Self {
        Thread {
            id: String::new(),
            title: "New thread".into(),
            session_id: None,
            archived: false,
            created_at: 0,
            split_ratio: 0.65,
            terminal_visible: false,
            terminal_maximized: false,
            model: None,
            permission_mode: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub state: AppState,
    /// Set when the state file was corrupt and moved aside.
    pub notice: Option<String>,
}

const STATE_FILE: &str = "state.json";
const TEMP_FILE: &str = "state.json.tmp";
const DEBOUNCE: Duration = Duration::from_millis(300);

struct Pending {
    state: Option<AppState>,
    last_save: Instant,
    shutdown: bool,
}

struct Shared {
    dir: PathBuf,
    pending: Mutex<Pending>,
    wake: Condvar,
    /// Serializes file writes so a later state can't be overwritten by an earlier one.
    write_lock: Mutex<()>,
}

impl Shared {
    /// Takes whatever is pending (if anything) and writes it.
    fn write_pending(&self) {
        let _w = self.write_lock.lock();
        let Some(state) = self.pending.lock().state.take() else { return };
        if let Err(e) = write_atomic(&self.dir, &state) {
            log::error!("saving app state to {} failed: {e}", self.dir.display());
        }
    }
}

pub struct StateStore {
    shared: Arc<Shared>,
}

impl StateStore {
    pub fn new(dir: PathBuf) -> Self {
        let shared = Arc::new(Shared {
            dir,
            pending: Mutex::new(Pending { state: None, last_save: Instant::now(), shutdown: false }),
            wake: Condvar::new(),
            write_lock: Mutex::new(()),
        });
        let bg = shared.clone();
        std::thread::spawn(move || debounce_loop(&bg));
        StateStore { shared }
    }

    pub fn load(&self) -> LoadResult {
        let path = self.shared.dir.join(STATE_FILE);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return LoadResult { state: AppState::default(), notice: None };
            }
            Err(e) => {
                return LoadResult {
                    state: AppState::default(),
                    notice: Some(format!("Couldn't read saved state at {}: {e}. Starting empty.", path.display())),
                };
            }
        };
        match serde_json::from_slice::<AppState>(&bytes) {
            Ok(mut state) => {
                state.version = STATE_VERSION;
                LoadResult { state, notice: None }
            }
            Err(parse_err) => {
                let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                let backup = self.shared.dir.join(format!("{STATE_FILE}.corrupt-{ms}"));
                let notice = match std::fs::rename(&path, &backup) {
                    Ok(()) => format!(
                        "Speedy's saved state was unreadable ({parse_err}) and was moved to {}. Starting with empty state.",
                        backup.display()
                    ),
                    Err(e) => format!(
                        "Speedy's saved state at {} was unreadable ({parse_err}) and couldn't be moved aside ({e}). Starting with empty state.",
                        path.display()
                    ),
                };
                LoadResult { state: AppState::default(), notice: Some(notice) }
            }
        }
    }

    /// Schedules a debounced atomic write.
    pub fn save(&self, mut state: AppState) {
        state.version = STATE_VERSION;
        let mut p = self.shared.pending.lock();
        p.state = Some(state);
        p.last_save = Instant::now();
        self.shared.wake.notify_one();
    }

    /// Writes any pending state immediately (quit).
    pub fn flush(&self) {
        self.shared.write_pending();
    }
}

impl Drop for StateStore {
    fn drop(&mut self) {
        self.shared.pending.lock().shutdown = true;
        self.shared.wake.notify_one();
    }
}

fn debounce_loop(shared: &Shared) {
    loop {
        {
            let mut p = shared.pending.lock();
            while p.state.is_none() && !p.shutdown {
                shared.wake.wait(&mut p);
            }
            if p.shutdown {
                return;
            }
            // Wait until no save has arrived for DEBOUNCE.
            loop {
                let deadline = p.last_save + DEBOUNCE;
                if Instant::now() >= deadline || p.shutdown || p.state.is_none() {
                    break;
                }
                shared.wake.wait_until(&mut p, deadline);
            }
        }
        shared.write_pending();
    }
}

/// Temp file in the same dir, fsync, rename over the real file, fsync the dir.
fn write_atomic(dir: &Path, state: &AppState) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(TEMP_FILE);
    let bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, dir.join(STATE_FILE))?;
    std::fs::File::open(dir)?.sync_all()
}

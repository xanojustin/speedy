//! U7: the agent's log, `~/Library/Logs/speedy-agent/agent.log`, rotated to `agent.log.1`
//! past [`MAX_LOG_BYTES`] so an always-on host doesn't grow it forever.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use parking_lot::Mutex;

pub const MAX_LOG_BYTES: u64 = 5 << 20;

pub fn log_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join("Library/Logs/speedy-agent")
}

pub struct FileLog {
    path: PathBuf,
    file: Mutex<Option<File>>,
}

impl FileLog {
    pub fn new() -> FileLog {
        let path = log_dir().join("agent.log");
        let _ = std::fs::create_dir_all(log_dir());
        FileLog { file: Mutex::new(open(&path)), path }
    }
}

impl Default for FileLog {
    fn default() -> Self {
        Self::new()
    }
}

fn open(path: &PathBuf) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

impl log::Log for FileLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }

    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let mut file = self.file.lock();
        if file.as_ref().and_then(|f| f.metadata().ok()).is_some_and(|m| m.len() > MAX_LOG_BYTES) {
            let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
            *file = open(&self.path);
        }
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let line = format!("{secs} {} {}: {}\n", r.level(), r.target(), r.args());
        match file.as_mut() {
            Some(f) => {
                let _ = f.write_all(line.as_bytes());
            }
            None => eprint!("{line}"),
        }
    }

    fn flush(&self) {}
}

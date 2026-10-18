//! U5/U11: lists and reads the CLI's own sessions under `~/.claude/projects` (KTD6).
//! Read-only except `session_rename_offline`, which appends one line in the CLI's format.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    /// Last `custom-title`, else last `ai-title`, else first user message.
    pub title: String,
    pub created_ms: u64,
    pub modified_ms: u64,
    pub file_path: String,
}

const TITLE_MAX_CHARS: usize = 80;

/// `~/.claude/projects`.
pub fn default_projects_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".claude/projects")
}

/// The CLI's directory name for a project folder: every character that isn't an
/// ASCII letter or digit becomes `-` (one per UTF-16 unit, as the CLI's JS regex does).
pub fn encode_project_dir(project_path: &str) -> String {
    project_path
        .chars()
        .flat_map(|c| {
            let n = if c.is_ascii_alphanumeric() { 0 } else { c.len_utf16() };
            std::iter::repeat_n('-', n).chain((n == 0).then_some(c))
        })
        .collect()
}

/// The CLI keeps encoded names up to this many characters; longer ones it cuts to
/// this length and suffixes with a hash of the path.
const MAX_ENCODED_DIR_LEN: usize = 200;

/// Finds the CLI's directory for `project_path`: the encoded name, or (for names
/// the CLI truncated) a directory holding a session whose `cwd` is the folder.
fn find_project_dir(root: &Path, project_path: &str) -> Option<PathBuf> {
    let encoded = encode_project_dir(project_path);
    let direct = root.join(&encoded);
    if direct.is_dir() {
        return Some(direct);
    }
    // Encoded names are ASCII, so `len` is the CLI's (UTF-16) length. A name the CLI
    // didn't truncate can only live at `direct`; skip the scan of every project.
    if encoded.len() <= MAX_ENCODED_DIR_LEN {
        return None;
    }
    std::fs::read_dir(root).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|dir| {
        dir.is_dir() && jsonl_files(dir).iter().any(|f| first_cwd(f).as_deref() == Some(project_path))
    })
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "jsonl") && p.is_file())
                .collect()
        })
        .unwrap_or_default()
}

/// The file's lines, stopping at the first read error (e.g. invalid UTF-8).
fn read_lines(file: &Path) -> std::io::Result<impl Iterator<Item = String>> {
    Ok(BufReader::new(std::fs::File::open(file)?).lines().map_while(Result::ok))
}

fn first_cwd(file: &Path) -> Option<String> {
    read_lines(file).ok()?.find_map(|line| {
        if !line.contains("\"cwd\"") {
            return None;
        }
        serde_json::from_str::<Value>(&line).ok()?.get("cwd")?.as_str().map(String::from)
    })
}

type CacheKey = (SystemTime, u64);

fn cache() -> &'static Mutex<HashMap<PathBuf, (CacheKey, SessionMeta)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (CacheKey, SessionMeta)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Sessions for a project folder, newest first. A folder the CLI has never seen lists nothing.
pub fn list_sessions(root: &Path, project_path: &str) -> Result<Vec<SessionMeta>, String> {
    let Some(dir) = find_project_dir(root, project_path) else { return Ok(vec![]) };
    let mut out: Vec<SessionMeta> = jsonl_files(&dir)
        .into_iter()
        .filter_map(|file| {
            let meta = std::fs::metadata(&file).ok()?;
            let mtime = meta.modified().ok()?;
            let key = (mtime, meta.len());
            if let Some((k, m)) = cache().lock().get(&file)
                && *k == key
            {
                return Some(m.clone());
            }
            let m = read_session_meta(&file, &meta)?;
            cache().lock().insert(file, (key, m.clone()));
            Some(m)
        })
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.session_id.cmp(&b.session_id)));
    Ok(out)
}

fn system_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn read_session_meta(file: &Path, meta: &std::fs::Metadata) -> Option<SessionMeta> {
    let session_id = file.file_stem()?.to_string_lossy().into_owned();
    let lines = read_lines(file).ok()?;
    let mut custom: Option<String> = None;
    let mut ai: Option<String> = None;
    let mut first_user: Option<String> = None;
    let mut created: Option<u64> = None;

    for line in lines {
        // Cheap prefilter: most lines in long sessions matter for none of these.
        let wants_title = line.contains("-title\"");
        let wants_user = first_user.is_none() && line.contains("\"user\"");
        let wants_ts = created.is_none() && line.contains("\"timestamp\"");
        if !(wants_title || wants_user || wants_ts) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if created.is_none() {
            created = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
        }
        match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    custom = Some(t.to_string());
                }
            }
            Some("ai-title") => {
                if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                    ai = Some(t.to_string());
                }
            }
            Some("user") if first_user.is_none() => first_user = user_text(&v),
            _ => {}
        }
    }

    let created_ms = created
        .or_else(|| meta.created().ok().map(system_ms))
        .unwrap_or_default();
    let title = custom
        .or(ai)
        .or(first_user)
        .unwrap_or_else(|| "Untitled session".into());
    Some(SessionMeta {
        session_id,
        title,
        created_ms,
        modified_ms: meta.modified().map(system_ms).unwrap_or_default(),
        file_path: file.to_string_lossy().into_owned(),
    })
}

/// The typed text of a real user turn. Skips meta/sidechain entries, tool results,
/// and injected `<tag>` blocks (IDE file context, slash-command wrappers).
fn user_text(v: &Value) -> Option<String> {
    if v.get("isMeta").and_then(Value::as_bool) == Some(true)
        || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let content = v.pointer("/message/content")?;
    let texts: Vec<&str> = match content {
        Value::String(s) => vec![s.as_str()],
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect(),
        _ => vec![],
    };
    texts
        .into_iter()
        .map(str::trim)
        .find(|t| !t.is_empty() && !t.starts_with('<'))
        .map(truncate_title)
}

fn truncate_title(text: &str) -> String {
    let first_line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if first_line.chars().count() <= TITLE_MAX_CHARS {
        first_line.to_string()
    } else {
        let cut: String = first_line.chars().take(TITLE_MAX_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Parses the CLI's `YYYY-MM-DDTHH:MM:SS(.fff)Z` timestamps to Unix ms.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.splitn(3, ':').map(|x| x.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    let ms: i64 = format!("{frac:0<3}")[..3].parse().ok()?;
    // Days from civil (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = ((days * 24 + h) * 60 + mi) * 60 + se;
    u64::try_from(total * 1000 + ms).ok()
}

fn session_file(root: &Path, project_path: &str, session_id: &str) -> Result<PathBuf, String> {
    // Session ids arrive from the webview; only the CLI's id alphabet may reach a path join.
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("invalid session id {session_id:?}"));
    }
    let dir = find_project_dir(root, project_path)
        .ok_or_else(|| format!("no Claude Code sessions found for {project_path}"))?;
    let file = dir.join(format!("{session_id}.jsonl"));
    if file.is_file() {
        Ok(file)
    } else {
        Err(format!("session {session_id} not found at {}", file.display()))
    }
}

/// How much of a session `session_load` returns, in JSONL bytes: half the protocol's 16 MiB
/// frame cap, leaving room for the reply's envelope and encoding overhead.
pub const SESSION_LOAD_MAX_BYTES: usize = 8 * 1024 * 1024;
const _: () = assert!(SESSION_LOAD_MAX_BYTES * 2 <= crate::proto::MAX_FRAME_LEN);

/// `type` of the record `load_session` puts first when it dropped the session's oldest lines.
/// It also carries `droppedLines`, the number of lines left out.
pub const TRUNCATED_MARKER_TYPE: &str = "speedy-history-truncated";

/// Every parseable JSON line of a session, in order, capped at [`SESSION_LOAD_MAX_BYTES`].
pub fn load_session(root: &Path, project_path: &str, session_id: &str) -> Result<Vec<Value>, String> {
    load_session_capped(root, project_path, session_id, SESSION_LOAD_MAX_BYTES)
}

/// [`load_session`] with an explicit cap: keeps the newest lines whose total size (with newlines)
/// is at most `max_bytes`, dropping whole lines from the oldest end. When any are dropped, the
/// result starts with a `{"type": TRUNCATED_MARKER_TYPE, "droppedLines": n}` record.
pub fn load_session_capped(root: &Path, project_path: &str, session_id: &str, max_bytes: usize) -> Result<Vec<Value>, String> {
    let file = session_file(root, project_path, session_id)?;
    let lines = read_lines(&file).map_err(|e| format!("reading {}: {e}", file.display()))?;
    // Holds raw lines (at most ~max_bytes of them) and parses only the kept ones.
    let mut kept: VecDeque<String> = VecDeque::new();
    let mut size = 0usize;
    let mut dropped = 0u64;
    for line in lines {
        size += line.len() + 1;
        kept.push_back(line);
        while size > max_bytes {
            let Some(old) = kept.pop_front() else { break };
            size -= old.len() + 1;
            dropped += 1;
        }
    }
    let records = kept.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok());
    if dropped == 0 {
        return Ok(records.collect());
    }
    let marker = serde_json::json!({ "type": TRUNCATED_MARKER_TYPE, "droppedLines": dropped });
    Ok(std::iter::once(marker).chain(records).collect())
}

/// Appends `{"type":"custom-title","customTitle":…,"sessionId":…}`, the line the CLI writes on rename.
pub fn rename_session_offline(root: &Path, project_path: &str, session_id: &str, title: &str) -> Result<(), String> {
    let file = session_file(root, project_path, session_id)?;
    let line = format!(
        r#"{{"type":"custom-title","customTitle":{},"sessionId":{}}}"#,
        Value::from(title),
        Value::from(session_id)
    );
    let err = |e: std::io::Error| format!("renaming session in {}: {e}", file.display());
    let mut f = std::fs::OpenOptions::new().read(true).append(true).open(&file).map_err(err)?;
    // Keep one entry per line even if the file doesn't end in a newline.
    let len = f.metadata().map_err(err)?.len();
    let mut prefix = "";
    if len > 0 {
        let mut last = [0u8; 1];
        f.seek(SeekFrom::End(-1)).map_err(err)?;
        f.read_exact(&mut last).map_err(err)?;
        if last[0] != b'\n' {
            prefix = "\n";
        }
    }
    f.write_all(format!("{prefix}{line}\n").as_bytes()).map_err(err)
}

/// Runs blocking file IO off the main thread and the async runtime's workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

pub async fn sessions_list(project_path: String) -> Result<Vec<SessionMeta>, String> {
    blocking(move || list_sessions(&default_projects_root(), &project_path)).await
}

/// A session's parseable JSONL lines, in order, for seeding a resumed transcript and for finding a
/// rewind's fork point (which walks the `parentUuid` chain). A session over the reply cap returns
/// only its newest lines, after a truncation marker (see [`load_session_capped`]).
pub async fn session_load(project_path: String, session_id: String) -> Result<Vec<Value>, String> {
    blocking(move || load_session(&default_projects_root(), &project_path, &session_id)).await
}

/// Appends a `custom-title` entry in the CLI's own format (no live actor).
pub async fn session_rename_offline(project_path: String, session_id: String, title: String) -> Result<(), String> {
    blocking(move || rename_session_offline(&default_projects_root(), &project_path, &session_id, &title)).await
}

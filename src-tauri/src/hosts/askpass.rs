//! U11: SSH passphrase and 2FA prompts in the app (KTD2). ssh runs the app's own binary as
//! `SSH_ASKPASS` (with `SSH_ASKPASS_REQUIRE=force`, since the app has no terminal); in that
//! mode the binary relays the prompt to the running app over a socket in a 0700 dir and prints
//! the answer. Each ssh master gets its own token (it may prompt more than once: a passphrase,
//! then a 2FA code), and only a same-user peer holding one can raise a prompt or read an
//! answer. Answers are never logged, stored or reused.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::oneshot;

const SOCKET_VAR: &str = "SPEEDY_ASKPASS_SOCKET";
const TOKEN_VAR: &str = "SPEEDY_ASKPASS_TOKEN";
/// How long a prompt waits for the user before ssh gives up on it.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

/// A prompt for the webview to show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: u64,
    pub host: String,
    pub prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    prompt: String,
}

pub struct Askpass {
    socket: PathBuf,
    /// One-time tokens for connects that may prompt, by token: the host alias.
    tokens: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next: Mutex<u64>,
    answer_timeout: Duration,
}

impl Askpass {
    /// Listens for prompts, handing each to `show`. Must be called inside a tokio runtime.
    pub fn start(show: impl Fn(Prompt) + Send + Sync + 'static) -> std::io::Result<Arc<Askpass>> {
        Self::start_in(dirs::home_dir().unwrap_or_default().join(".speedy/askpass"), ANSWER_TIMEOUT, show)
    }

    /// [`Askpass::start`] with the socket in `dir` and prompts given up on after
    /// `answer_timeout` (tests use a temporary dir and a short timeout).
    pub fn start_in(
        dir: PathBuf,
        answer_timeout: Duration,
        show: impl Fn(Prompt) + Send + Sync + 'static,
    ) -> std::io::Result<Arc<Askpass>> {
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        let socket = dir.join(format!("{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket)?;
        let askpass =
            Arc::new(Askpass { socket, tokens: Mutex::default(), pending: Mutex::default(), next: Mutex::new(1), answer_timeout });
        let (server, show) = (askpass.clone(), Arc::new(show));
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (server, show) = (server.clone(), show.clone());
                tokio::spawn(async move { server.serve(stream, &*show).await });
            }
        });
        Ok(askpass)
    }

    /// Env for one ssh master that may prompt on behalf of `host`.
    pub fn env_for(&self, host: &str) -> Vec<(String, String)> {
        let token = uuid::Uuid::new_v4().to_string();
        self.tokens.lock().insert(token.clone(), host.to_owned());
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        vec![
            ("SSH_ASKPASS".into(), exe),
            (SOCKET_VAR.into(), self.socket.to_string_lossy().into_owned()),
            (TOKEN_VAR.into(), token),
        ]
    }

    /// The user's answer to prompt `id`; `None` cancels it.
    pub fn answer(&self, id: u64, answer: Option<String>) {
        if let Some(tx) = self.pending.lock().remove(&id) {
            let _ = tx.send(answer);
        }
    }

    async fn serve(&self, stream: tokio::net::UnixStream, show: &(dyn Fn(Prompt) + Send + Sync)) {
        if !stream.peer_cred().is_ok_and(|c| c.uid() == unsafe { libc::geteuid() }) {
            return;
        }
        let (rd, mut wr) = stream.into_split();
        let mut line = String::new();
        if tokio::io::BufReader::new(rd).read_line(&mut line).await.is_err() {
            return;
        }
        let Ok(req) = serde_json::from_str::<Request>(&line) else { return };
        let Some(host) = self.tokens.lock().get(&req.token).cloned() else { return };
        let id = {
            let mut next = self.next.lock();
            *next += 1;
            *next
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        show(Prompt { id, host, prompt: req.prompt });
        let answer = tokio::time::timeout(self.answer_timeout, rx).await.ok().and_then(|r| r.ok()).flatten();
        self.pending.lock().remove(&id);
        if let Some(answer) = answer {
            let _ = wr.write_all(format!("{answer}\n").as_bytes()).await;
        }
    }
}

impl Drop for Askpass {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// When ssh runs this binary as its askpass helper: relay the prompt and print the answer.
/// Returns `None` when this process isn't an askpass helper.
pub fn helper_main() -> Option<i32> {
    let socket = std::env::var_os(SOCKET_VAR)?;
    let token = std::env::var(TOKEN_VAR).unwrap_or_default();
    let prompt = std::env::args().nth(1).unwrap_or_else(|| "Password:".into());
    match ask(Path::new(&socket), &token, &prompt) {
        Some(answer) => {
            print!("{answer}");
            Some(0)
        }
        // Cancelled or closed: ssh treats a failed askpass as a refused prompt.
        None => Some(1),
    }
}

/// The helper's side of the protocol: sends `prompt` with `token` to the app's socket and
/// returns the answer line (with its newline), or `None` when cancelled, refused or closed.
pub fn ask(socket: &Path, token: &str, prompt: &str) -> Option<String> {
    let mut stream = std::os::unix::net::UnixStream::connect(socket).ok()?;
    let request = serde_json::to_string(&Request { token: token.to_owned(), prompt: prompt.to_owned() }).expect("serializes");
    writeln!(stream, "{request}").ok()?;
    let mut answer = String::new();
    match BufReader::new(stream).read_line(&mut answer) {
        Ok(n) if n > 0 => Some(answer),
        _ => None,
    }
}

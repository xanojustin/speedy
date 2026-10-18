//! U11: the askpass server and its helper's protocol, over a real Unix socket in a temp dir.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use speedy_lib::hosts::askpass::{Askpass, Prompt, ask};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(10);

struct Server {
    _dir: tempfile::TempDir,
    askpass: Arc<Askpass>,
    shown: mpsc::UnboundedReceiver<Prompt>,
}

fn start(timeout: Duration) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let (tx, shown) = mpsc::unbounded_channel();
    let askpass = Askpass::start_in(dir.path().join("askpass"), timeout, move |p| {
        let _ = tx.send(p);
    })
    .unwrap();
    Server { _dir: dir, askpass, shown }
}

/// The socket and token ssh would hand the helper for `host`.
fn env(askpass: &Askpass, host: &str) -> (PathBuf, String) {
    let env = askpass.env_for(host);
    let var = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).unwrap();
    assert!(env.iter().any(|(k, _)| k == "SSH_ASKPASS"));
    (PathBuf::from(var("SPEEDY_ASKPASS_SOCKET")), var("SPEEDY_ASKPASS_TOKEN"))
}

/// Runs the blocking helper protocol off the runtime.
fn helper(socket: PathBuf, token: String, prompt: &str) -> tokio::task::JoinHandle<Option<String>> {
    let prompt = prompt.to_owned();
    tokio::task::spawn_blocking(move || ask(&socket, &token, &prompt))
}

async fn next_prompt(shown: &mut mpsc::UnboundedReceiver<Prompt>) -> Prompt {
    tokio::time::timeout(WAIT, shown.recv()).await.expect("a prompt is shown").unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answered_prompt_reaches_the_helper_and_names_its_host() {
    let mut server = start(WAIT);
    let (socket, token) = env(&server.askpass, "mac-mini");
    let reply = helper(socket.clone(), token.clone(), "Enter passphrase for key:");
    let prompt = next_prompt(&mut server.shown).await;
    assert_eq!(prompt.host, "mac-mini");
    assert_eq!(prompt.prompt, "Enter passphrase for key:");
    server.askpass.answer(prompt.id, Some("pw".into()));
    assert_eq!(reply.await.unwrap().as_deref(), Some("pw\n"));

    // The same master may prompt again (a 2FA code after the passphrase), under a new id.
    let reply = helper(socket, token, "Verification code:");
    let second = next_prompt(&mut server.shown).await;
    assert_ne!(second.id, prompt.id);
    assert_eq!(second.host, "mac-mini");
    server.askpass.answer(second.id, Some("123456".into()));
    assert_eq!(reply.await.unwrap().as_deref(), Some("123456\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_token_is_closed_without_a_prompt() {
    let mut server = start(WAIT);
    let (socket, _) = env(&server.askpass, "mac-mini");
    let reply = tokio::time::timeout(WAIT, helper(socket.clone(), "not-a-token".into(), "Password:")).await.unwrap();
    assert_eq!(reply.unwrap(), None);

    // Garbage that isn't a request is closed the same way.
    let mut raw = tokio::net::UnixStream::connect(&socket).await.unwrap();
    raw.write_all(b"not json\n").await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(WAIT, raw.read_to_end(&mut out)).await.unwrap().unwrap();
    assert!(out.is_empty());
    assert!(server.shown.try_recv().is_err(), "show is never called");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_prompt_closes_with_no_answer() {
    let mut server = start(WAIT);
    let (socket, token) = env(&server.askpass, "mac-mini");
    let reply = helper(socket, token, "Password:");
    let prompt = next_prompt(&mut server.shown).await;
    server.askpass.answer(prompt.id, None);
    assert_eq!(tokio::time::timeout(WAIT, reply).await.unwrap().unwrap(), None);
    // A late answer to a finished prompt goes nowhere.
    server.askpass.answer(prompt.id, Some("late".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unanswered_prompt_times_out_with_no_answer() {
    let mut server = start(Duration::from_millis(200));
    let (socket, token) = env(&server.askpass, "mac-mini");
    let reply = helper(socket, token, "Password:");
    let prompt = next_prompt(&mut server.shown).await;
    assert_eq!(tokio::time::timeout(WAIT, reply).await.unwrap().unwrap(), None);
    // Answering after the timeout is a no-op rather than a panic.
    server.askpass.answer(prompt.id, Some("pw".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_socket_lives_in_a_private_dir() {
    use std::os::unix::fs::PermissionsExt;
    let server = start(WAIT);
    let (socket, _) = env(&server.askpass, "mac-mini");
    let mode = std::fs::metadata(socket.parent().unwrap()).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    assert!(socket.exists());
}

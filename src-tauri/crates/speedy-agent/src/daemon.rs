//! U6: the `run`, `proxy` and `stop` subcommands (KTD2, KTD8).
//!
//! `run` holds an exclusive `flock` on `state/agent.lock` for its lifetime, which makes it
//! the host's only agent; a second `run` exits 0 so launchd doesn't respawn it. `proxy`
//! relays stdio to the socket and exits [`EXIT_NOT_RUNNING`] when no agent holds the lock.
//! `install` replaces a running agent only through [`restart_if_idle`] (KTD9).

use std::fs::{DirBuilder, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use speedy_core::env::{EnvService, install_command_env};
use speedy_core::host::migrate::migrate_host;
use speedy_core::host::{Host, HostPaths, Launch, LaunchFn};
use speedy_core::proto::{Body, Control, Frame, FrameReader, PROTOCOL_MAX, PROTOCOL_MIN, Hello, Request, encode};
use speedy_core::state::{chats_dir, default_state_dir};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};

use crate::paths::AgentPaths;
use crate::power::{IdleSleepAssertion, hold_awake_while_working};
use crate::token::claude_env;
use crate::server::{AGENT_VERSION, Agent, BUILD_SHA, peer_allowed};

/// `proxy` exit code when no agent is running, so the client installs or starts one.
pub const EXIT_NOT_RUNNING: i32 = 90;
/// `install` exit code when the running agent was busy and kept running; the app retries later.
pub const EXIT_BUSY: i32 = 91;

/// Creates the state dir with mode 0700 (KTD12).
pub fn ensure_state_dir(paths: &AgentPaths) -> io::Result<()> {
    let dir = paths.state_dir();
    DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
}

/// The exclusive agent lock, or `None` when another agent holds it.
pub fn try_lock(paths: &AgentPaths) -> io::Result<Option<File>> {
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(paths.lock())?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EWOULDBLOCK) { Ok(None) } else { Err(err) }
}

/// The host's stable id, created on first start (KTD10).
pub fn host_id(paths: &AgentPaths) -> io::Result<String> {
    let path = paths.host_id();
    match std::fs::read_to_string(&path) {
        Ok(id) if !id.trim().is_empty() => Ok(id.trim().to_owned()),
        _ => {
            let id = uuid::Uuid::new_v4().to_string();
            std::fs::write(&path, &id)?;
            Ok(id)
        }
    }
}

/// How the host launches `claude`: the resolved login env plus, for this child only, the token.
fn launch_from(env: Arc<EnvService>, paths: AgentPaths) -> LaunchFn {
    Arc::new(move || {
        let (env, paths) = (env.clone(), paths.clone());
        Box::pin(async move {
            let program = env.claude_path().await.ok_or("claude CLI not found; finish setup first")?;
            let vars = claude_env(&paths, env.env().await.vars);
            Ok(Launch { program, env: vars, extension_settings: env.extension_settings() })
        })
    })
}

/// `speedy-agent run`: serve until a client asks to stop or a signal arrives.
pub async fn run(paths: AgentPaths) -> io::Result<()> {
    ensure_state_dir(&paths)?;
    let Some(_lock) = try_lock(&paths)? else {
        log::info!("another agent is running; exiting");
        return Ok(());
    };
    let host_id = host_id(&paths)?;
    // The first run on a Mac that ran Speedy before hosts takes over its projects (R18).
    if let Some(notice) = migrate_host(&default_state_dir(), &paths.state_dir()) {
        log::warn!("{notice}");
    }
    let env = Arc::new(EnvService::start());
    let resolving = env.clone();
    tokio::spawn(async move { install_command_env(resolving.env().await.vars) });
    let host = Host::open(
        HostPaths { state_dir: paths.state_dir(), chats_dir: chats_dir(), worktrees_dir: default_state_dir().join("worktrees") },
        launch_from(env.clone(), paths.clone()),
    );
    let (statuses, events) = host.subscribe();
    tokio::spawn(hold_awake_while_working(statuses.statuses, events, IdleSleepAssertion::default()));
    host.resume_queues();
    let agent = Agent::new(host, env, host_id, paths.clone());

    // We hold the lock, so any socket here is stale.
    let socket = paths.socket();
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    log::info!("serving on {}", socket.display());

    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                match stream.peer_cred() {
                    Ok(cred) if peer_allowed(cred.uid()) => {
                        tokio::spawn(agent.clone().serve(stream));
                    }
                    other => log::warn!("refused a connection from another user: {other:?}"),
                }
            }
            _ = agent.shutdown_requested() => break,
            _ = term.recv() => break,
            _ = int.recv() => break,
        }
    }
    log::info!("shutting down");
    let stopping = agent.clone();
    let _ = tokio::task::spawn_blocking(move || stopping.shut_down()).await;
    let _ = std::fs::remove_file(&socket);
    Ok(())
}

/// `speedy-agent proxy`: relays stdin/stdout to the agent's socket. Returns the exit code.
pub async fn proxy(paths: AgentPaths) -> i32 {
    if !agent_running(&paths) {
        return EXIT_NOT_RUNNING;
    }
    let mut socket = match UnixStream::connect(paths.socket()).await {
        Ok(s) => s,
        Err(_) => return EXIT_NOT_RUNNING,
    };
    let mut stdio = tokio::io::join(tokio::io::stdin(), tokio::io::stdout());
    let _ = tokio::io::copy_bidirectional(&mut stdio, &mut socket).await;
    0
}

/// Whether an agent holds the lock (a missing state dir means none ever ran).
pub fn agent_running(paths: &AgentPaths) -> bool {
    if !paths.state_dir().exists() {
        return false;
    }
    matches!(try_lock(paths), Ok(None))
}

/// How long `stop` waits for the agent to exit after asking it to.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// `speedy-agent stop`: asks the running agent to shut down and waits for it to go.
pub async fn stop(paths: AgentPaths) -> io::Result<()> {
    stop_within(paths, STOP_TIMEOUT).await
}

/// [`stop`], failing when the agent still holds its lock after `timeout`.
pub async fn stop_within(paths: AgentPaths, timeout: Duration) -> io::Result<()> {
    if !agent_running(&paths) {
        return Ok(());
    }
    let (_reader, mut wr) = connect(&paths).await?;
    send(&mut wr, Body::Control(Control::Shutdown)).await?;
    // The agent exits once its threads and shells have stopped.
    wait_for_exit(&paths, timeout).await
}

/// Asks the running agent to shut down if nothing would be interrupted, and waits for it to
/// go. True when no agent runs any more; false when it was busy and keeps running.
pub async fn restart_if_idle(paths: &AgentPaths) -> io::Result<bool> {
    if !agent_running(paths) {
        return Ok(true);
    }
    let (mut reader, mut wr) = connect(paths).await?;
    match call(&mut reader, &mut wr, "restart_if_idle").await? {
        Some(Ok(Value::Bool(false))) => return Ok(false),
        Some(Ok(_)) => {}
        // An agent from before `restart_if_idle`: the old, racy check is all it offers.
        Some(Err(e)) if e.starts_with("unknown method") => {
            if call(&mut reader, &mut wr, "agent_busy").await? != Some(Ok(Value::Bool(false))) {
                return Ok(false);
            }
            send(&mut wr, Body::Control(Control::Shutdown)).await?;
        }
        Some(Err(e)) => return Err(io::Error::other(e)),
        // It closed the connection before replying: it may be on its way out.
        None => {}
    }
    wait_for_exit(paths, STOP_TIMEOUT).await.map(|()| true)
}

/// Opens a connection to the running agent and says Hello.
async fn connect(paths: &AgentPaths) -> io::Result<(FrameReader<OwnedReadHalf>, OwnedWriteHalf)> {
    let stream = UnixStream::connect(paths.socket()).await?;
    let (rd, mut wr) = stream.into_split();
    let mut reader = FrameReader::new(rd);
    reader.read_preamble().await.map_err(io::Error::other)?;
    let hello = Hello {
        protocol_min: PROTOCOL_MIN,
        protocol_max: PROTOCOL_MAX,
        agent_version: AGENT_VERSION.into(),
        build_sha: BUILD_SHA.into(),
        host_id: None,
        epoch: None,
        capabilities: vec![],
    };
    send(&mut wr, Body::Control(Control::Hello(hello))).await?;
    Ok((reader, wr))
}

async fn send(wr: &mut OwnedWriteHalf, body: Body) -> io::Result<()> {
    let bytes = encode(&Frame { stream_id: 0, body }).map_err(io::Error::other)?;
    wr.write_all(&bytes).await
}

/// One RPC with no params; `None` when the agent closed the connection before replying.
async fn call(reader: &mut FrameReader<OwnedReadHalf>, wr: &mut OwnedWriteHalf, method: &str) -> io::Result<Option<Result<Value, String>>> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    send(wr, Body::Request(Request { id, method: method.into(), params: Value::Null })).await?;
    loop {
        let frame = match tokio::time::timeout(STOP_TIMEOUT, reader.read_frame()).await {
            Ok(Ok(Some(frame))) => frame,
            Ok(Ok(None)) | Ok(Err(_)) => return Ok(None),
            Err(_) => return Err(io::Error::new(io::ErrorKind::TimedOut, format!("the agent didn't answer {method}"))),
        };
        if let Body::Response(r) = frame.body
            && r.id == id
        {
            return Ok(Some(r.result));
        }
    }
}

/// Waits for the agent to release its lock.
async fn wait_for_exit(paths: &AgentPaths, timeout: Duration) -> io::Result<()> {
    let deadline = tokio::time::Instant::now() + timeout;
    while agent_running(paths) {
        if tokio::time::Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("the agent didn't stop within {}s", timeout.as_secs_f32()),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

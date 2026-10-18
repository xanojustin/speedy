//! U5: the host owns projects, threads and their behavior (KTD6), and every thread's
//! events can be replayed from a cursor (KTD5).
//!
//! [`Host`] persists projects and threads in `host.json` and changes them only through
//! the operations below, each of which is broadcast to every host subscriber. Each thread
//! runs one [`ClaudeActor`] and does what the webview used to: it queues messages sent
//! mid-turn and sends them in order, echoes each sent message as `user_sent` (the CLI
//! doesn't), titles a new thread from its first message, records the session binding, and
//! creates a requested worktree before the first start. All of it works with no client
//! attached, and a client that connects later catches up from the thread's [`log`].

pub mod log;
pub mod migrate;
pub mod snapshot;
pub mod store;
mod thread;

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::claude::actor::{self, ActorConfig, ClaudeActor};
use crate::claude::{ClaudeEvent, StartOptions, ThreadStatus};
use crate::state::store::{JsonStore, ThreadWorktree};
use log::Cursor;
pub use snapshot::ThreadSnapshot;
use store::{DEFAULT_TITLE, ForkFrom, HostProject, HostState, HostThread, QueueItem};
use thread::ThreadRuntime;

/// Each thread's replay log is capped at this many bytes (KTD5).
pub const LOG_CAP_BYTES: usize = 64 << 20;
const TITLE_MAX: usize = 60;
/// The Chats project's name, as the sidebar and thread header show it.
const CHATS_NAME: &str = "No Project";

/// Where the host keeps its files.
#[derive(Debug, Clone)]
pub struct HostPaths {
    /// Holds `host.json`.
    pub state_dir: PathBuf,
    /// The Chats project's folder.
    pub chats_dir: PathBuf,
    /// Base for thread worktrees.
    pub worktrees_dir: PathBuf,
}

/// How to launch `claude`: resolved per start, since setup can change while running.
pub struct Launch {
    pub program: PathBuf,
    pub env: HashMap<String, String>,
    pub extension_settings: Map<String, Value>,
}

pub type LaunchFn = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Launch, String>> + Send>> + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewThread {
    pub id: String,
    pub title: Option<String>,
    pub created_at: u64,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub worktree_requested: bool,
    /// A rewind fork: the new thread resumes this session, truncated, as a new session.
    pub fork: Option<ForkFrom>,
}

/// Thread fields a client may change; `None` leaves a field as it is.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThreadPatch {
    pub title: Option<String>,
    pub archived: Option<bool>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub worktree_requested: Option<bool>,
}

/// Everything a host subscriber needs before live host events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub epoch: u64,
    pub projects: Vec<HostProject>,
    /// Status of every thread that has run since the agent started; others are `not_started`.
    pub statuses: HashMap<String, ThreadStatus>,
}

/// What a thread subscriber needs before live thread events.
#[derive(Debug)]
pub enum ThreadReplay {
    Events(Vec<Arc<Value>>),
    Snapshot(ThreadSnapshot),
}

pub struct Host {
    me: Weak<Host>,
    paths: HostPaths,
    launch: LaunchFn,
    epoch: u64,
    store: JsonStore<HostState>,
    /// Lock order: a thread's `live`, then `state`; never the reverse.
    state: Mutex<HostState>,
    threads: Mutex<HashMap<String, Arc<ThreadRuntime>>>,
    subscribers: Mutex<Vec<UnboundedSender<Arc<Value>>>>,
}

impl Host {
    /// Loads `host.json` (adding the Chats project if missing). Must be called inside a tokio runtime.
    pub fn open(paths: HostPaths, launch: LaunchFn) -> Arc<Host> {
        let store = JsonStore::<HostState>::new(paths.state_dir.clone());
        let loaded = store.load();
        if let Some(notice) = &loaded.notice {
            ::log::warn!("{notice}");
        }
        let mut state = loaded.state;
        if let Err(e) = std::fs::create_dir_all(&paths.chats_dir) {
            ::log::error!("creating the Chats folder {} failed: {e}", paths.chats_dir.display());
        }
        if !state.projects.iter().any(|p| p.scratch) {
            state.projects.insert(
                0,
                HostProject {
                    id: "chats".into(),
                    path: paths.chats_dir.to_string_lossy().into_owned(),
                    name: CHATS_NAME.into(),
                    scratch: true,
                    threads: vec![],
                },
            );
            store.save(state.clone());
        }
        Arc::new_cyclic(|me| Host {
            me: me.clone(),
            paths,
            launch,
            epoch: uuid::Uuid::new_v4().as_u64_pair().0,
            store,
            state: Mutex::new(state),
            threads: Mutex::default(),
            subscribers: Mutex::default(),
        })
    }

    /// Changes every time the agent starts; the first half of every cursor.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    // ---- host-level state ----

    pub fn snapshot(&self) -> HostSnapshot {
        let statuses = self.threads.lock().iter().map(|(id, rt)| (id.clone(), rt.status())).collect();
        HostSnapshot { epoch: self.epoch, projects: self.state.lock().projects.clone(), statuses }
    }

    /// The current projects and threads, then every change to them.
    pub fn subscribe(&self) -> (HostSnapshot, UnboundedReceiver<Arc<Value>>) {
        let (tx, rx) = unbounded_channel();
        // Taken under the subscriber lock: a change broadcast after this is delivered, and
        // one made just before may arrive twice, which is harmless because upserts repeat.
        let mut subs = self.subscribers.lock();
        let snapshot = self.snapshot();
        subs.push(tx);
        (snapshot, rx)
    }

    pub fn thread(&self, id: &str) -> Option<HostThread> {
        self.state.lock().thread(id).map(|(_, t)| t.clone())
    }

    pub fn thread_status(&self, id: &str) -> Option<ThreadStatus> {
        if let Some(rt) = self.threads.lock().get(id) {
            return Some(rt.status());
        }
        self.state.lock().thread(id).map(|_| ThreadStatus::NotStarted)
    }

    pub fn add_project(&self, project: NewProject) -> Result<(), String> {
        let mut state = self.state.lock();
        if state.projects.iter().any(|p| p.id == project.id) {
            return Err(format!("project {} already exists", project.id));
        }
        let project = HostProject { id: project.id, path: project.path, name: project.name, scratch: false, threads: vec![] };
        let event = json!({"kind": "project_upserted", "project": project});
        state.projects.push(project);
        self.save(&state);
        drop(state);
        self.broadcast(event);
        Ok(())
    }

    pub fn remove_project(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock();
        let at = state.projects.iter().position(|p| p.id == id && !p.scratch).ok_or_else(|| format!("no project {id}"))?;
        let project = state.projects.remove(at);
        self.save(&state);
        drop(state);
        let mut threads = self.threads.lock();
        for t in &project.threads {
            threads.remove(&t.id);
        }
        drop(threads);
        self.broadcast(json!({"kind": "project_removed", "id": id}));
        Ok(())
    }

    pub fn create_thread(&self, project_id: &str, new: NewThread) -> Result<(), String> {
        let mut state = self.state.lock();
        if state.thread(&new.id).is_some() {
            return Err(format!("thread {} already exists", new.id));
        }
        let project = state.project_mut(project_id).ok_or_else(|| format!("no project {project_id}"))?;
        let thread = HostThread {
            id: new.id,
            title: new.title.unwrap_or_else(|| DEFAULT_TITLE.into()),
            created_at: new.created_at,
            model: new.model,
            permission_mode: new.permission_mode,
            worktree_requested: new.worktree_requested,
            fork: new.fork,
            ..HostThread::default()
        };
        let event = json!({"kind": "thread_upserted", "projectId": project_id, "thread": thread});
        project.threads.push(thread);
        self.save(&state);
        drop(state);
        self.broadcast(event);
        Ok(())
    }

    pub fn update_thread(&self, id: &str, patch: ThreadPatch) -> Result<(), String> {
        self.edit_thread(id, |t| {
            if let Some(title) = patch.title {
                t.title = title;
            }
            if let Some(archived) = patch.archived {
                t.archived = archived;
            }
            if patch.model.is_some() {
                t.model = patch.model;
            }
            if patch.permission_mode.is_some() {
                t.permission_mode = patch.permission_mode;
            }
            if let Some(requested) = patch.worktree_requested {
                t.worktree_requested = requested;
            }
        })
    }

    pub fn remove_thread(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock();
        let project = state.projects.iter_mut().find(|p| p.threads.iter().any(|t| t.id == id)).ok_or_else(|| format!("no thread {id}"))?;
        project.threads.retain(|t| t.id != id);
        self.save(&state);
        drop(state);
        self.threads.lock().remove(id);
        self.broadcast(json!({"kind": "thread_removed", "id": id}));
        Ok(())
    }

    // ---- threads ----

    /// The thread's replay from `cursor` (or a snapshot), then its live events.
    pub fn subscribe_thread(&self, id: &str, cursor: Option<Cursor>) -> Result<(ThreadReplay, UnboundedReceiver<Arc<Value>>), String> {
        let rt = self.runtime(id)?;
        let session_id = || self.state.lock().thread(id).and_then(|(_, t)| t.session_id.clone());
        Ok(rt.subscribe(cursor, session_id))
    }

    /// Spawns the thread's `claude` if it isn't running (lazy, KTD9), creating a requested
    /// worktree first, or relaunches a Stopped one. Returns the current status.
    pub async fn ensure_started(&self, id: &str) -> Result<ThreadStatus, String> {
        let rt = self.runtime(id)?;
        let _starting = rt.starting.lock().await;
        if let Some(actor) = rt.actor() {
            return Ok(match actor.status() {
                ThreadStatus::Stopped => actor.restart(self.start_options(id)?),
                status => status,
            });
        }
        self.prepare_worktree(id).await?;
        let options = self.start_options(id)?;
        let launch = (self.launch)().await?;
        let config = ActorConfig { program: launch.program, options, env: launch.env, extension_settings: launch.extension_settings };
        let (me, thread_id) = (self.me.clone(), id.to_owned());
        let sink: actor::EventSink = Arc::new(move |event| {
            if let Some(host) = me.upgrade() {
                host.on_actor_event(&thread_id, event);
            }
        });
        let actor = ClaudeActor::start(config, sink, Arc::new(|_, _| {}));
        let status = actor.status();
        rt.set_actor(actor);
        Ok(status)
    }

    /// Sends now when the thread is idle; otherwise queues the message and sends it after the
    /// current turn (and anything queued before it). A start failure keeps it queued for a retry.
    pub async fn send(&self, id: &str, content: Value) -> Result<(), String> {
        self.title_from(id, &content);
        let started = self.ensure_started(id).await.is_ok();
        let rt = self.runtime(id)?;
        let queue = {
            let mut live = rt.live.lock();
            if started && live.can_send_now() {
                live.in_flight = true;
                None
            } else {
                live.queue.push(QueueItem { id: uuid::Uuid::new_v4().to_string(), content: content.clone() });
                self.persist_queue(id, &live.queue);
                Some(live.queue.clone())
            }
        };
        match queue {
            None => self.write_user(&rt, content).await,
            Some(queue) => {
                rt.publish(json!({"kind": "queue_changed", "queue": queue}));
            }
        }
        Ok(())
    }

    pub fn remove_queued(&self, id: &str, item_id: &str) -> Result<(), String> {
        let rt = self.runtime(id)?;
        let queue = {
            let mut live = rt.live.lock();
            live.queue.retain(|q| q.id != item_id);
            self.persist_queue(id, &live.queue);
            live.queue.clone()
        };
        rt.publish(json!({"kind": "queue_changed", "queue": queue}));
        Ok(())
    }

    /// The running actor, for control requests, permission answers, interrupt, stop and retry.
    pub fn actor(&self, id: &str) -> Result<ClaudeActor, String> {
        self.threads.lock().get(id).and_then(|rt| rt.actor()).ok_or_else(|| format!("thread {id} has no claude session"))
    }

    /// The KTD9 quit sequence across every running thread; blocks up to `grace` before SIGKILL.
    pub fn shutdown(&self, grace: Duration) {
        let actors: Vec<ClaudeActor> = self.threads.lock().values().filter_map(|rt| rt.actor()).collect();
        actor::shutdown_all(&actors, grace);
    }

    /// Writes pending state immediately.
    pub fn flush(&self) {
        self.store.flush();
    }

    // ---- internals ----

    fn runtime(&self, id: &str) -> Result<Arc<ThreadRuntime>, String> {
        let mut threads = self.threads.lock();
        if let Some(rt) = threads.get(id) {
            return Ok(rt.clone());
        }
        let queue = self.state.lock().thread(id).map(|(_, t)| t.queue.clone()).ok_or_else(|| format!("no thread {id}"))?;
        let rt = Arc::new(ThreadRuntime::new(self.epoch, queue));
        threads.insert(id.to_owned(), rt.clone());
        Ok(rt)
    }

    fn on_actor_event(&self, id: &str, event: ClaudeEvent) {
        let Ok(rt) = self.runtime(id) else { return };
        let value = serde_json::to_value(&event).expect("ClaudeEvent serializes");
        rt.publish(value);
        match event {
            ClaudeEvent::SessionBound { session_id, .. } => {
                let _ = self.edit_thread(id, |t| {
                    t.session_id = Some(session_id);
                    t.fork = None;
                });
            }
            ClaudeEvent::Status { status, .. } => {
                self.broadcast(json!({"kind": "thread_status", "id": id, "status": status}));
                match status {
                    ThreadStatus::Idle => self.spawn_flush(id),
                    ThreadStatus::Crashed | ThreadStatus::Errored | ThreadStatus::Stopped => rt.live.lock().in_flight = false,
                    _ => {}
                }
            }
            ClaudeEvent::Message { raw, .. } if raw["type"] == "result" => {
                rt.live.lock().in_flight = false;
                self.spawn_flush(id);
            }
            _ => {}
        }
    }

    /// Sends the next queued message once the turn in flight finishes.
    fn spawn_flush(&self, id: &str) {
        let (Some(host), id) = (self.me.upgrade(), id.to_owned()) else { return };
        tokio::spawn(async move {
            let Ok(rt) = host.runtime(&id) else { return };
            let (next, queue) = {
                let mut live = rt.live.lock();
                if live.in_flight || live.queue.is_empty() {
                    return;
                }
                live.in_flight = true;
                let next = live.queue.remove(0);
                host.persist_queue(&id, &live.queue);
                (next, live.queue.clone())
            };
            rt.publish(json!({"kind": "queue_changed", "queue": queue}));
            host.write_user(&rt, next.content).await;
        });
    }

    /// Echoes the message as `user_sent` (the CLI doesn't), then writes it. The caller has set `in_flight`.
    async fn write_user(&self, rt: &ThreadRuntime, content: Value) {
        let id = uuid::Uuid::new_v4().to_string();
        rt.publish(json!({"kind": "user_sent", "id": id, "content": content}));
        let result = match rt.actor() {
            Some(actor) => actor.send_user(content).await,
            None => Err("claude isn't running".to_owned()),
        };
        if let Err(error) = result {
            rt.live.lock().in_flight = false;
            rt.publish(json!({"kind": "send_failed", "id": id, "error": error}));
        }
    }

    /// Titles a new thread from its first message.
    fn title_from(&self, id: &str, content: &Value) {
        let text = content
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["type"] == "text")
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            return;
        }
        let untitled = self.state.lock().thread(id).is_some_and(|(_, t)| t.title == DEFAULT_TITLE && t.session_id.is_none());
        if untitled {
            let title = match text.char_indices().nth(TITLE_MAX) {
                Some((cut, _)) => format!("{}…", text[..cut].trim_end()),
                None => text,
            };
            let _ = self.edit_thread(id, |t| t.title = title);
        }
    }

    /// Gives a thread that asked for a worktree its own checkout before its first start, on a
    /// new `speedy/<id>` branch from the project folder's `HEAD`.
    async fn prepare_worktree(&self, id: &str) -> Result<(), String> {
        let (root, branch) = {
            let state = self.state.lock();
            let (project, thread) = state.thread(id).ok_or_else(|| format!("no thread {id}"))?;
            if !thread.worktree_requested || thread.worktree.is_some() || thread.session_id.is_some() {
                return Ok(());
            }
            (PathBuf::from(&project.path), format!("speedy/{}", id.chars().take(8).collect::<String>()))
        };
        let base = self.paths.worktrees_dir.clone();
        let worktree = tokio::task::spawn_blocking(move || crate::worktree::create(&root, &branch, &base))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Couldn't create a worktree: {e}"))?;
        self.edit_thread(id, |t| {
            t.worktree = Some(ThreadWorktree { path: worktree.path, branch: worktree.branch });
            t.worktree_requested = false;
        })
    }

    fn start_options(&self, id: &str) -> Result<StartOptions, String> {
        let state = self.state.lock();
        let (project, thread) = state.thread(id).ok_or_else(|| format!("no thread {id}"))?;
        let (resume_session_id, resume_session_at, fork_session) = match &thread.fork {
            Some(fork) => (Some(fork.resume_session_id.clone()), Some(fork.resume_session_at.clone()), Some(true)),
            None => (thread.session_id.clone(), None, None),
        };
        Ok(StartOptions {
            cwd: thread.cwd(project),
            resume_session_id,
            resume_session_at,
            fork_session,
            model: thread.model.clone(),
            permission_mode: thread.permission_mode.clone(),
            max_thinking_tokens: None,
        })
    }

    /// Applies `edit` to the thread, saves, and broadcasts the updated thread.
    fn edit_thread(&self, id: &str, edit: impl FnOnce(&mut HostThread)) -> Result<(), String> {
        let mut state = self.state.lock();
        let project = state.projects.iter_mut().find(|p| p.threads.iter().any(|t| t.id == id)).ok_or_else(|| format!("no thread {id}"))?;
        let thread = project.threads.iter_mut().find(|t| t.id == id).expect("found above");
        edit(thread);
        let event = json!({"kind": "thread_upserted", "projectId": project.id, "thread": thread});
        self.save(&state);
        drop(state);
        self.broadcast(event);
        Ok(())
    }

    /// Mirrors a thread's live queue into `host.json`. Called with the thread's `live` locked.
    fn persist_queue(&self, id: &str, queue: &[QueueItem]) {
        let mut state = self.state.lock();
        if let Some(thread) = state.thread_mut(id) {
            thread.queue = queue.to_vec();
            self.save(&state);
        }
    }

    fn save(&self, state: &HostState) {
        self.store.save(state.clone());
    }

    fn broadcast(&self, event: Value) {
        let event = Arc::new(event);
        self.subscribers.lock().retain(|tx| tx.send(event.clone()).is_ok());
    }
}

// Typed wrappers over the Tauri commands registered in src-tauri/src/lib.rs.
// Thread and terminal calls go to the host that owns the thread (R15); file, git, worktree and
// session calls take the owning host explicitly, since a path alone can't name a host (two hosts
// can share a path, and a worktree lives outside its project's folder). The app forwards them over
// `host_call` and the subscription commands (KTD3).
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  LOCAL_HOST,
  type ClaudeEvent,
  type ClientState,
  type ConnState,
  type DirEntry,
  type ExtensionSettings,
  type FileDiff,
  type FileHit,
  type ForkFrom,
  type GitChange,
  type HostEvent,
  type HostInfo,
  type HostSetupState,
  type AskpassPrompt,
  type LoadResult,
  type MenuAction,
  type PermissionMode,
  type PermissionOutcome,
  type PermissionResult,
  type PtyExit,
  type SessionMeta,
  type SetupState,
  type ThreadPatch,
  type ThreadStatus,
  type ThreadWorktree,
  type UnusedWorktree,
  type WorktreeCleanReport,
} from "./types";

// ---- host routing ----

type HostLookup = { threadId: string };
let lookupHost: (key: HostLookup) => string | undefined = () => undefined;

/** Installed by the app store, which knows each thread's host. */
export function setHostLookup(fn: (key: HostLookup) => string | undefined) {
  lookupHost = fn;
}

const hostOfThread = (threadId: string) => lookupHost({ threadId }) ?? LOCAL_HOST;
/** Terminal ids are `<threadId>` or `<threadId>:<n>`. */
const hostOfTerminal = (terminalId: string) => hostOfThread(terminalId.split(":")[0]);

export const hostCall = <T>(host: string, method: string, params: Record<string, unknown> = {}) =>
  invoke<T>("host_call", { host, method, params });

/** Host events: a `host_snapshot` on every (re)connect, then upserts and status changes. */
export function hostSubscribe(host: string, onEvent: (e: HostEvent) => void) {
  const channel = new Channel<HostEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("host_subscribe", { host, onEvent: channel });
}

export function hostWatch(host: string, onState: (s: ConnState) => void) {
  const channel = new Channel<ConnState>();
  channel.onmessage = onState;
  return invoke<void>("host_watch", { host, onState: channel });
}

export const hostList = () => invoke<HostInfo[]>("host_list");
/** `~/.ssh/config` aliases that aren't hosts yet. */
export const hostAliases = () => invoke<string[]>("host_aliases");
/** Adds an SSH host and waits for its first connection (installing the agent there if needed). */
export const hostAdd = (alias: string) => invoke<HostInfo>("host_add", { alias });
export const hostRemove = (host: string) => invoke<void>("host_remove", { host });
/** A user-initiated reconnect, which may ask for a passphrase. */
export const hostReconnect = (host: string) => invoke<void>("host_reconnect", { host });
export const askpassAnswer = (id: number, answer: string | null) => invoke<void>("askpass_answer", { id, answer });
export const onAskpass = (cb: (p: AskpassPrompt) => void): Promise<UnlistenFn> => listen<AskpassPrompt>("askpass", (e) => cb(e.payload));
export const localAgentStop = () => invoke<void>("local_agent_stop");
export const localAgentStart = () => invoke<void>("local_agent_start");
export const quitConfirmed = () => invoke<void>("quit_confirmed");
export const onQuitRequested = (cb: (working: number) => void): Promise<UnlistenFn> =>
  listen<{ working: number }>("quit_requested", (e) => cb(e.payload.working));
/** Where a host's folder browser starts. */
export const homeDir = (host: string) => hostCall<string | null>(host, "home_dir");
/** Saves the `claude setup-token` token on a host that can't reach its Keychain (KTD8). */
export const setClaudeToken = (host: string, token: string) => hostCall<HostSetupState>(host, "set_claude_token", { token });

export const projectAdd = (host: string, project: { id: string; path: string; name: string }) =>
  hostCall<void>(host, "project_add", project);
export const projectRemove = (host: string, id: string) => hostCall<void>(host, "project_remove", { id });
export interface NewThread {
  id: string;
  title?: string | null;
  createdAt: number;
  model?: string | null;
  permissionMode?: PermissionMode | null;
  worktreeRequested?: boolean;
  sessionId?: string | null;
  worktree?: ThreadWorktree | null;
  fork?: ForkFrom | null;
}
export const threadCreate = (host: string, projectId: string, thread: NewThread) =>
  hostCall<void>(host, "thread_create", { projectId, thread });
export const threadUpdate = (threadId: string, patch: ThreadPatch) =>
  hostCall<void>(hostOfThread(threadId), "thread_update", { threadId, patch });
export const threadRemove = (threadId: string) => hostCall<void>(hostOfThread(threadId), "thread_remove", { threadId });
export const queueRemove = (threadId: string, id: string) => hostCall<void>(hostOfThread(threadId), "queue_remove", { threadId, id });

// ---- setup (per host, KTD7) ----
export const getSetupState = (host = LOCAL_HOST) => hostCall<HostSetupState>(host, "get_setup_state");
export const recheckSetup = (overridePath?: string | null, host = LOCAL_HOST) =>
  hostCall<SetupState>(host, "recheck_setup", { overridePath: overridePath ?? null });
export const getExtensionSettings = (host = LOCAL_HOST) => hostCall<ExtensionSettings>(host, "get_extension_settings");

// ---- claude ----
/** The thread's events, continuous across reconnects; returns the subscription id. */
export function threadSubscribe(threadId: string, onEvent: (e: ClaudeEvent) => void) {
  const channel = new Channel<ClaudeEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("host_thread_subscribe", { host: hostOfThread(threadId), threadId, onEvent: channel });
}
/** Spawns the thread's `claude` if it isn't running (the host creates a requested worktree first). */
export const claudeStart = (threadId: string) => hostCall<ThreadStatus>(hostOfThread(threadId), "claude_start", { threadId });
/** Sends now, or queues on the host until the current turn finishes. */
export const claudeSendUser = (threadId: string, content: unknown[]) =>
  hostCall<void>(hostOfThread(threadId), "claude_send_user", { threadId, content });
export const claudeControl = <T = unknown>(threadId: string, request: { subtype: string; [k: string]: unknown }, timeoutMs?: number) =>
  hostCall<T>(hostOfThread(threadId), "claude_control", { threadId, request, timeoutMs: timeoutMs ?? null });
export const claudeRespondPermission = (threadId: string, requestId: string, response: PermissionResult) =>
  hostCall<PermissionOutcome>(hostOfThread(threadId), "claude_respond_permission", { threadId, requestId, response });
export const claudeInterrupt = (threadId: string) => hostCall<void>(hostOfThread(threadId), "claude_interrupt", { threadId });
export const claudeStop = (threadId: string) => hostCall<void>(hostOfThread(threadId), "claude_stop", { threadId });
export const claudeRetry = (threadId: string) => hostCall<ThreadStatus>(hostOfThread(threadId), "claude_retry", { threadId });

// ---- pty ----
/** Attaches to the terminal (starting its shell if absent). Output on `onData`, the shell's exit on `onExit`. */
export function ptyOpen(
  terminalId: string,
  cwd: string,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onExit: (e: PtyExit) => void,
) {
  const data = new Channel<ArrayBuffer>();
  data.onmessage = (buf) => onData(new Uint8Array(buf));
  const exit = new Channel<{ code: number | null }>();
  exit.onmessage = (e) => onExit({ terminalId, code: e.code });
  return invoke<number>("host_pty_attach", { host: hostOfTerminal(terminalId), terminalId, cwd, cols, rows, onData: data, onExit: exit });
}
export const ptyWrite = (terminalId: string, data: string) => hostCall<void>(hostOfTerminal(terminalId), "pty_write", { terminalId, data });
export const ptyResize = (terminalId: string, cols: number, rows: number) =>
  invoke<void>("host_pty_resize", { host: hostOfTerminal(terminalId), terminalId, cols, rows });
export const ptyClose = (terminalId: string) => hostCall<void>(hostOfTerminal(terminalId), "pty_close", { terminalId });
export const ptyHasForegroundChild = (terminalId: string) =>
  hostCall<boolean>(hostOfTerminal(terminalId), "pty_has_foreground_child", { terminalId });
export const unsubscribe = (host: string, subId: number) => invoke<void>("host_unsubscribe", { host, subId });

// ---- client prefs + session index ----
export const clientStateLoad = () => invoke<LoadResult<ClientState>>("client_state_load");
export const clientStateSave = (state: ClientState) => invoke<void>("client_state_save", { state });
/** Asks `host` (This Mac by default: drag-and-drop and the native picker are local). */
export const pathsExist = (paths: string[], host = LOCAL_HOST) => hostCall<boolean[]>(host, "paths_exist", { paths });
export const sessionsList = (host: string, projectPath: string) => hostCall<SessionMeta[]>(host, "sessions_list", { projectPath });
export const sessionLoad = (host: string, projectPath: string, sessionId: string) =>
  hostCall<Record<string, unknown>[]>(host, "session_load", { projectPath, sessionId });
export const sessionRenameOffline = (host: string, projectPath: string, sessionId: string, title: string) =>
  hostCall<void>(host, "session_rename_offline", { projectPath, sessionId, title });

// ---- files ----
export const filesSearch = (host: string, root: string, query: string, limit?: number, respectGitignore?: boolean) =>
  hostCall<FileHit[]>(host, "files_search", { root, query, limit: limit ?? null, respectGitignore: respectGitignore ?? null });

// ---- explorer ----
export const explorerList = (host: string, root: string, dir: string) => hostCall<DirEntry[]>(host, "explorer_list", { root, dir });
export const explorerRead = (host: string, root: string, path: string) => hostCall<string>(host, "explorer_read", { root, path });
export const explorerWrite = (host: string, root: string, path: string, content: string) =>
  hostCall<void>(host, "explorer_write", { root, path, content });
export const explorerGitStatus = (host: string, root: string) => hostCall<GitChange[]>(host, "explorer_git_status", { root });
export const explorerGitBranch = (host: string, root: string) => hostCall<string | null>(host, "explorer_git_branch", { root });
/** Speedy's worktrees of `root`'s repository that hold no path in `keep`. Changes nothing. */
export const worktreeUnused = (host: string, root: string, keep: string[]) => hostCall<UnusedWorktree[]>(host, "worktree_unused", { root, keep });
/** Removes the listed worktrees (Speedy's own only) and their merged branches. */
export const worktreeClean = (host: string, root: string, paths: string[]) => hostCall<WorktreeCleanReport>(host, "worktree_clean", { root, paths });
export const explorerGitDiff = (host: string, root: string, path: string) => hostCall<FileDiff>(host, "explorer_git_diff", { root, path });

// ---- attention ----
export const attentionSetVisible = (threadId: string | null) => invoke<void>("attention_set_visible", { threadId });
export const attentionMarkRead = (threadId: string) => invoke<void>("attention_mark_read", { threadId });
/** Thread id → title, so notifications can name the thread. */
export const attentionSetTitles = (titles: Record<string, string>) => invoke<void>("attention_set_titles", { titles });
/** Notification settings (`notificationsEnabled` / `completionSound`). */
export const attentionSetPrefs = (notifications: boolean, sound: string | null) =>
  invoke<void>("attention_set_prefs", { notifications, sound });
/** Plays a completion sound (settings preview). */
export const playSound = (name: string) => invoke<void>("play_sound", { name });
/** Every window's appearance (what `setTheme` in `@tauri-apps/api/app` calls); null follows macOS. */
export const setAppTheme = (theme: "light" | "dark" | null) => invoke<void>("plugin:app|set_app_theme", { theme });
export const onOpenThread = (cb: (threadId: string) => void): Promise<UnlistenFn> =>
  listen<{ threadId: string }>("attention-open-thread", (e) => cb(e.payload.threadId));
export const onUnread = (cb: (unread: string[]) => void): Promise<UnlistenFn> =>
  listen<{ unread: string[] }>("attention-unread", (e) => cb(e.payload.unread));

// ---- menu ----
/** Menu actions for this window: Rust sends each to the focused window only. */
export const onMenu = (cb: (action: MenuAction) => void): Promise<UnlistenFn> =>
  listen<MenuAction>("menu", (e) => cb(e.payload), { target: { kind: "WebviewWindow", label: windowLabel() } });

/** This window's label ("main" for the first). */
function windowLabel(): string {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label ?? "main";
}

// ---- `speedy .` ----
export const openFoldersTake = () => invoke<string[]>("open_folders_take");
/** Fires when the OS hands Speedy folders; call `openFoldersTake` to get them. */
export const onOpenFolders = (cb: () => void): Promise<UnlistenFn> => listen("open-folders", () => cb());

// ---- misc ----
export const openPath = (path: string) => invoke<void>("open_path", { path });
/** A folder on an SSH host opens as a VS Code remote window there. */
export const openInVscode = (path: string, host: string = LOCAL_HOST) => invoke<void>("open_in_vscode", { path, host });

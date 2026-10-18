// Typed wrappers over the Tauri commands registered in src-tauri/src/lib.rs.
// Thread, terminal, file and git calls go to the host that owns the thread or path (R15):
// the app forwards them over `host_call` and the subscription commands (KTD3).
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

type HostLookup = { threadId?: string; path?: string };
let lookupHost: (key: HostLookup) => string | undefined = () => undefined;

/** Installed by the app store, which knows each project's host. */
export function setHostLookup(fn: (key: HostLookup) => string | undefined) {
  lookupHost = fn;
}

const hostOfThread = (threadId: string) => lookupHost({ threadId }) ?? LOCAL_HOST;
const hostOfPath = (path: string) => lookupHost({ path }) ?? LOCAL_HOST;
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
export const queueRemove = (threadId: string, id: string) => hostCall<void>(hostOfThread(threadId), "queue_remove", { threadId, id });

// ---- setup (per host, KTD7) ----
export const getSetupState = (host = LOCAL_HOST) => hostCall<SetupState>(host, "get_setup_state");
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
/** Asks This Mac (drag-and-drop and the native picker are local). */
export const pathsExist = (paths: string[]) => hostCall<boolean[]>(LOCAL_HOST, "paths_exist", { paths });
export const sessionsList = (projectPath: string) => hostCall<SessionMeta[]>(hostOfPath(projectPath), "sessions_list", { projectPath });
export const sessionLoad = (projectPath: string, sessionId: string) =>
  hostCall<Record<string, unknown>[]>(hostOfPath(projectPath), "session_load", { projectPath, sessionId });
export const sessionRenameOffline = (projectPath: string, sessionId: string, title: string) =>
  hostCall<void>(hostOfPath(projectPath), "session_rename_offline", { projectPath, sessionId, title });

// ---- files ----
export const filesSearch = (root: string, query: string, limit?: number, respectGitignore?: boolean) =>
  hostCall<FileHit[]>(hostOfPath(root), "files_search", { root, query, limit: limit ?? null, respectGitignore: respectGitignore ?? null });

// ---- explorer ----
export const explorerList = (root: string, dir: string) => hostCall<DirEntry[]>(hostOfPath(root), "explorer_list", { root, dir });
export const explorerRead = (root: string, path: string) => hostCall<string>(hostOfPath(root), "explorer_read", { root, path });
export const explorerWrite = (root: string, path: string, content: string) =>
  hostCall<void>(hostOfPath(root), "explorer_write", { root, path, content });
export const explorerGitStatus = (root: string) => hostCall<GitChange[]>(hostOfPath(root), "explorer_git_status", { root });
export const explorerGitBranch = (root: string) => hostCall<string | null>(hostOfPath(root), "explorer_git_branch", { root });
/** Speedy's worktrees of `root`'s repository that hold no path in `keep`. Changes nothing. */
export const worktreeUnused = (root: string, keep: string[]) => hostCall<UnusedWorktree[]>(hostOfPath(root), "worktree_unused", { root, keep });
/** Removes the listed worktrees (Speedy's own only) and their merged branches. */
export const worktreeClean = (root: string, paths: string[]) => hostCall<WorktreeCleanReport>(hostOfPath(root), "worktree_clean", { root, paths });
export const explorerGitDiff = (root: string, path: string) => hostCall<FileDiff>(hostOfPath(root), "explorer_git_diff", { root, path });

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
export const onOpenThread = (cb: (threadId: string) => void): Promise<UnlistenFn> =>
  listen<{ threadId: string }>("attention-open-thread", (e) => cb(e.payload.threadId));
export const onUnread = (cb: (unread: string[]) => void): Promise<UnlistenFn> =>
  listen<{ unread: string[] }>("attention-unread", (e) => cb(e.payload.unread));

// ---- menu ----
export const onMenu = (cb: (action: MenuAction) => void): Promise<UnlistenFn> =>
  listen<MenuAction>("menu", (e) => cb(e.payload));

// ---- `speedy .` ----
export const openFoldersTake = () => invoke<string[]>("open_folders_take");
/** Fires when the OS hands Speedy folders; call `openFoldersTake` to get them. */
export const onOpenFolders = (cb: () => void): Promise<UnlistenFn> => listen("open-folders", () => cb());

// ---- misc ----
export const openPath = (path: string) => invoke<void>("open_path", { path });
export const openInVscode = (path: string) => invoke<void>("open_in_vscode", { path });

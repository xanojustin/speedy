// Typed wrappers over the Tauri commands registered in src-tauri/src/lib.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppState,
  ClaudeEvent,
  DirEntry,
  ExtensionSettings,
  FileDiff,
  FileHit,
  GitChange,
  LoadResult,
  MenuAction,
  PermissionOutcome,
  PermissionResult,
  PtyExit,
  SessionMeta,
  SetupState,
  StartOptions,
  ThreadStatus,
  ThreadWorktree,
} from "./types";

// ---- env ----
export const getSetupState = () => invoke<SetupState>("get_setup_state");
export const recheckSetup = (overridePath?: string | null) =>
  invoke<SetupState>("recheck_setup", { overridePath: overridePath ?? null });
export const getExtensionSettings = () => invoke<ExtensionSettings>("get_extension_settings");

// ---- claude ----
export function claudeStart(threadId: string, options: StartOptions, onEvent: (e: ClaudeEvent) => void) {
  const channel = new Channel<ClaudeEvent>();
  channel.onmessage = onEvent;
  return invoke<ThreadStatus>("claude_start", { threadId, options, onEvent: channel });
}
export const claudeSendUser = (threadId: string, content: unknown[]) =>
  invoke<void>("claude_send_user", { threadId, content });
export const claudeControl = <T = unknown>(threadId: string, request: { subtype: string; [k: string]: unknown }, timeoutMs?: number) =>
  invoke<T>("claude_control", { threadId, request, timeoutMs: timeoutMs ?? null });
export const claudeRespondPermission = (threadId: string, requestId: string, response: PermissionResult) =>
  invoke<PermissionOutcome>("claude_respond_permission", { threadId, requestId, response });
export const claudeInterrupt = (threadId: string) => invoke<void>("claude_interrupt", { threadId });
export const claudeStop = (threadId: string) => invoke<void>("claude_stop", { threadId });
export const claudeRetry = (threadId: string) => invoke<ThreadStatus>("claude_retry", { threadId });

// ---- pty ----
export function ptyOpen(terminalId: string, cwd: string, cols: number, rows: number, onData: (bytes: Uint8Array) => void) {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buf) => onData(new Uint8Array(buf));
  return invoke<void>("pty_open", { terminalId, cwd, cols, rows, onData: channel });
}
export const ptyWrite = (terminalId: string, data: string) => invoke<void>("pty_write", { terminalId, data });
export const ptyResize = (terminalId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { terminalId, cols, rows });
export const ptyClose = (terminalId: string) => invoke<void>("pty_close", { terminalId });
export const ptyHasForegroundChild = (terminalId: string) => invoke<boolean>("pty_has_foreground_child", { terminalId });
export const onPtyExit = (cb: (e: PtyExit) => void): Promise<UnlistenFn> =>
  listen<PtyExit>("pty-exit", (e) => cb(e.payload));

// ---- state + session index ----
export const stateLoad = () => invoke<LoadResult>("state_load");
export const stateSave = (state: AppState) => invoke<void>("state_save", { state });
export const pathsExist = (paths: string[]) => invoke<boolean[]>("paths_exist", { paths });
export const sessionsList = (projectPath: string) => invoke<SessionMeta[]>("sessions_list", { projectPath });
export const sessionLoad = (projectPath: string, sessionId: string) =>
  invoke<Record<string, unknown>[]>("session_load", { projectPath, sessionId });
export const sessionRenameOffline = (projectPath: string, sessionId: string, title: string) =>
  invoke<void>("session_rename_offline", { projectPath, sessionId, title });

// ---- files ----
export const filesSearch = (root: string, query: string, limit?: number, respectGitignore?: boolean) =>
  invoke<FileHit[]>("files_search", { root, query, limit: limit ?? null, respectGitignore: respectGitignore ?? null });

// ---- explorer ----
export const explorerList = (root: string, dir: string) => invoke<DirEntry[]>("explorer_list", { root, dir });
export const explorerRead = (root: string, path: string) => invoke<string>("explorer_read", { root, path });
export const explorerWrite = (root: string, path: string, content: string) =>
  invoke<void>("explorer_write", { root, path, content });
export const explorerGitStatus = (root: string) => invoke<GitChange[]>("explorer_git_status", { root });
export const explorerGitBranch = (root: string) => invoke<string | null>("explorer_git_branch", { root });
export const worktreeCreate = (root: string, branch: string) => invoke<ThreadWorktree>("worktree_create", { root, branch });
export const explorerGitDiff = (root: string, path: string) => invoke<FileDiff>("explorer_git_diff", { root, path });

// ---- attention ----
export const attentionSetVisible = (threadId: string | null) => invoke<void>("attention_set_visible", { threadId });
export const attentionMarkRead = (threadId: string) => invoke<void>("attention_mark_read", { threadId });
/** Thread id → title, so notifications can name the thread. */
export const attentionSetTitles = (titles: Record<string, string>) => invoke<void>("attention_set_titles", { titles });
/** Notification settings (AppState `notificationsEnabled` / `completionSound`). */
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

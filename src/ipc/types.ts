// TS mirror of the Rust IPC contract (src-tauri/src/**). Keep the two in sync.

type SetupStatus = "resolving" | "ready" | "cli_not_found" | "not_logged_in" | "error";

export interface SetupState {
  status: SetupStatus;
  claudePath: string | null;
  claudeVersion: string | null;
  fixtureVersion: string;
  versionMismatch: boolean;
  searchedPaths: string[];
  envDegraded: boolean;
  message: string | null;
}

/** Effective `claudeCode.*` settings, keyed by full setting name. */
export type ExtensionSettings = Record<string, unknown>;

export type ThreadStatus =
  | "not_started"
  | "starting"
  | "idle"
  | "working"
  | "awaiting_user"
  | "crashed"
  | "errored"
  | "stopped";

/** A process is running (starting, idle, working or awaiting the user), not stopped or failed. */
export function isLiveStatus(status: ThreadStatus): boolean {
  return status === "starting" || status === "idle" || status === "working" || status === "awaiting_user";
}

export interface FileDiff {
  path: string;
  isNewFile: boolean;
  unified: string;
  baseFingerprint: string;
}

/** A raw stream-json line from the CLI. Typed loosely; see `src/store/sdk.ts`. */
export type RawMessage = { type: string; [key: string]: unknown };

export type ClaudeEvent =
  | { kind: "message"; seq: number; raw: RawMessage }
  | { kind: "initialized"; seq: number; response: Record<string, unknown> }
  | { kind: "session_bound"; seq: number; session_id: string }
  | {
      kind: "status";
      seq: number;
      status: ThreadStatus;
      detail: string | null;
      stderr_tail: string | null;
      reconnecting: boolean;
    }
  | {
      kind: "permission_request";
      seq: number;
      request_id: string;
      request: CanUseToolRequest;
      diff: FileDiff[] | null;
    }
  | { kind: "permission_resolved"; seq: number; request_id: string; reason: string }
  | { kind: "diff_refreshed"; seq: number; request_id: string; diff: FileDiff[] }
  // Thread events the host adds (KTD6): the message it wrote, the queue, a failed send.
  | { kind: "user_sent"; seq: number; id: string; content: unknown[] }
  | { kind: "queue_changed"; seq: number; queue: QueueItem[] }
  | { kind: "send_failed"; seq: number; id: string; error: string }
  // From the app's connection: catch-up the agent couldn't replay, or a refused subscribe.
  | { kind: "snapshot"; seq?: number; snapshot: ThreadSnapshot }
  | { kind: "subscribe_failed"; seq?: number; error: string }
  | { kind: "stderr"; seq: number; text: string }
  | { kind: "protocol_error"; seq: number; line: string };

/** The `request` body of a `can_use_tool` control_request (CLI 2.1.296). */
export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  display_name?: string;
  input: Record<string, unknown>;
  description?: string;
  title?: string;
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  tool_use_id?: string;
  agent_id?: string;
}

export type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

export type PermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: PermissionDestination;
    }
  | { type: "setMode"; mode: PermissionMode; destination: PermissionDestination }
  | { type: "addDirectories" | "removeDirectories"; directories: string[]; destination: PermissionDestination };

export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export interface StartOptions {
  cwd: string;
  resumeSessionId?: string | null;
  /** With resumeSessionId: keep history only up to and including this message uuid (rewind). */
  resumeSessionAt?: string | null;
  /** With resumeSessionId: continue in a new session id (rewind fork). */
  forkSession?: boolean | null;
  model?: string | null;
  permissionMode?: PermissionMode | null;
  maxThinkingTokens?: number | null;
}

/** A message waiting for the current turn, held by the host. */
export interface QueueItem {
  id: string;
  content: unknown[];
}

/** A thread's live state when the host can't replay what a client missed (KTD5). */
export interface ThreadSnapshot {
  epoch: number;
  seq: number;
  sessionId: string | null;
  queue: QueueItem[];
  /** Live events to reduce after seeding history: init, session, pending prompts, partials, status. */
  events: ClaudeEvent[];
}

export interface PermissionOutcome {
  sent: boolean;
  refreshedDiff: FileDiff[] | null;
}

// ---- Hosts (KTD6, KTD14) ----

/** This Mac's host key. */
export const LOCAL_HOST = "local";

/** A thread as its host stores it. */
export interface HostThread {
  id: string;
  title: string;
  sessionId: string | null;
  archived: boolean;
  createdAt: number;
  model: string | null;
  permissionMode: PermissionMode | null;
  worktree: ThreadWorktree | null;
  worktreeRequested: boolean;
  fork: ForkFrom | null;
  queue: QueueItem[];
}

export interface HostProject {
  id: string;
  path: string;
  name: string;
  scratch: boolean;
  threads: HostThread[];
}

export interface ForkFrom {
  resumeSessionId: string;
  resumeSessionAt: string | null;
}

export interface HostSnapshot {
  epoch: number;
  projects: HostProject[];
  statuses: Record<string, ThreadStatus>;
}

export type HostEvent =
  | { kind: "host_snapshot"; snapshot: HostSnapshot }
  | { kind: "project_upserted"; project: HostProject }
  | { kind: "project_removed"; id: string }
  | { kind: "thread_upserted"; projectId: string; thread: HostThread }
  | { kind: "thread_removed"; id: string }
  | { kind: "thread_status"; id: string; status: ThreadStatus }
  | { kind: "subscribe_failed"; error: string };

/** Thread fields a client may change on its host. */
export interface ThreadPatch {
  title?: string;
  archived?: boolean;
  model?: string | null;
  permissionMode?: PermissionMode | null;
  worktreeRequested?: boolean;
  clearWorktree?: boolean;
}

export type ConnState =
  | { state: "connecting" }
  | { state: "connected"; host_id: string; agent_version: string }
  | { state: "reconnecting"; error: string };

/** A host and how it's doing (R3). */
export interface HostInfo {
  key: string;
  state: ConnState;
  /** A newer agent waits for this one to go idle ("pending"), or can't talk to this app while it's busy ("blocked"). */
  update: "pending" | "blocked" | null;
}

/** An SSH passphrase or code prompt (KTD2). */
export interface AskpassPrompt {
  id: number;
  host: string;
  prompt: string;
}

/** How a host's agent runs, beside its setup state (KTD8). */
export interface HostSetupState extends SetupState {
  /** "aqua" when it runs in the console session (Keychain available), else "background" or another domain. */
  launchDomain?: string;
  tokenPresent?: boolean;
}

/** The app's own preferences (`client.json`), keyed by host and project. */
export interface ClientState {
  version: number;
  groups: Group[];
  /** Per-project prefs, in display order. */
  projects: { hostId: string; projectId: string; collapsed: boolean; groupId: string | null }[];
  /** Per-thread layout, in display order within each project. */
  threads: { threadId: string; splitRatio: number; terminalVisible: boolean; terminalMaximized: boolean }[];
  selectedThreadId: string | null;
  sidebarWidth: number;
  notificationsEnabled: boolean;
  completionSound: string | null;
  activityPanelVisible: boolean;
  claudePathOverride: string | null;
}

// ---- App state: the webview's merged view of hosts and client prefs ----

export interface AppState {
  version: number;
  projects: Project[];
  /** Sidebar sections that projects can be filed under, in display order. */
  groups: Group[];
  selectedThreadId: string | null;
  claudePathOverride: string | null;
  sidebarWidth: number;
  /** Post a system notification when a hidden thread finishes or needs input. */
  notificationsEnabled: boolean;
  /** System sound played when a thread needs attention (src-tauri/src/attention.rs `SOUNDS`); null = silent. */
  completionSound: string | null;
  /** Show the activity panel (the agent's todos and subagents) above the composer. */
  activityPanelVisible: boolean;
}

export interface Project {
  id: string;
  /** The host this project lives on (R13). */
  hostKey: string;
  path: string;
  name: string;
  collapsed: boolean;
  /** The group this project is filed under; null (or an unknown id) = ungrouped. */
  groupId?: string | null;
  /** Speedy's built-in Chats project: threads not tied to any folder, pinned atop the sidebar. */
  scratch?: boolean;
  threads: Thread[];
}

export interface Group {
  id: string;
  /** The host whose projects this group holds; This Mac when unset. */
  hostKey?: string;
  name: string;
  collapsed: boolean;
  /** A `GROUP_COLORS` name; null is filled in on load. */
  color: GroupColor | null;
}

/** Group colors, drawn from the theme's `--vscode-charts-*` palette. */
export const GROUP_COLORS = ["blue", "green", "orange", "purple", "red", "yellow"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export interface Thread {
  id: string;
  title: string;
  sessionId: string | null;
  archived: boolean;
  createdAt: number;
  splitRatio: number;
  terminalVisible: boolean;
  terminalMaximized: boolean;
  model: string | null;
  permissionMode: PermissionMode | null;
  /** Set when the thread runs in its own git worktree instead of the project folder. */
  worktree?: ThreadWorktree | null;
  /** Create a worktree when the thread starts (set before its first message). */
  worktreeRequested?: boolean;
  /** A rewind fork's starting point, until its own session binds. */
  fork?: ForkFrom | null;
}

export interface ThreadWorktree {
  /** The thread's working directory inside the worktree. */
  path: string;
  branch: string;
}

/** A worktree a cleanup would remove, shown before anything happens. */
export interface UnusedWorktree {
  path: string;
  /** Null for a detached HEAD. */
  branch: string | null;
  /** Uncommitted or untracked changes: git won't remove it. */
  dirty: boolean;
  /** The branch holds no unmerged commits, so the cleanup deletes it too. */
  merged: boolean;
}

export interface WorktreeCleanReport {
  removed: string[];
  /** Worktrees git refused to remove (changed since the preview, locked, …), with git's reason. */
  skipped: { path: string; reason: string }[];
  deletedBranches: string[];
}

export interface LoadResult<T> {
  state: T;
  notice: string | null;
}

export interface SessionMeta {
  sessionId: string;
  title: string;
  createdMs: number;
  modifiedMs: number;
  filePath: string;
}

/**
 * `type` of the record `session_load` puts first when the session was too large to return whole
 * (session_index.rs `TRUNCATED_MARKER_TYPE`): only the newest lines follow it, and
 * `droppedLines` says how many older ones were left out.
 */
export const SESSION_TRUNCATED_TYPE = "speedy-history-truncated";

export const TRUNCATED_HISTORY_NOTICE = "Older messages in this session weren't loaded (it's too large).";

export interface FileHit {
  path: string;
  isDir: boolean;
}

export interface DirEntry {
  name: string;
  /** Relative to the project root, `/`-separated. */
  path: string;
  isDir: boolean;
  /** Matched by a gitignore rule; shown dimmed. */
  ignored: boolean;
}

/** `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked, `C` conflicted. */
export type GitStatus = "M" | "A" | "D" | "R" | "U" | "C";

export interface GitChange {
  path: string;
  status: GitStatus;
}

export interface PtyExit {
  terminalId: string;
  code: number | null;
}

/** Menu item ids emitted on the `menu` app event (src-tauri/src/menu.rs). */
export type MenuAction =
  | "new_thread"
  | "close_thread"
  | "toggle_terminal"
  | "maximize_terminal"
  | "new_terminal"
  | "toggle_explorer"
  | "focus_chat"
  | "add_project"
  | "open_settings"
  | "stop_local_agent"
  | `switch_thread_${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

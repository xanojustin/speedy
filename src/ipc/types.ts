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

export interface PermissionOutcome {
  sent: boolean;
  refreshedDiff: FileDiff[] | null;
}

// ---- App state (KTD6) ----

export interface AppState {
  version: number;
  projects: Project[];
  selectedThreadId: string | null;
  claudePathOverride: string | null;
  sidebarWidth: number;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  collapsed: boolean;
  threads: Thread[];
}

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
}

export interface LoadResult {
  state: AppState;
  notice: string | null;
}

export interface SessionMeta {
  sessionId: string;
  title: string;
  createdMs: number;
  modifiedMs: number;
  filePath: string;
}

export interface FileHit {
  path: string;
  isDir: boolean;
}

export interface PtyExit {
  threadId: string;
  code: number | null;
}

/** Menu item ids emitted on the `menu` app event (src-tauri/src/menu.rs). */
export type MenuAction =
  | "new_thread"
  | "close_thread"
  | "toggle_terminal"
  | "maximize_terminal"
  | "focus_chat"
  | "add_project"
  | `switch_thread_${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

// Test double for the Tauri IPC boundary (@tauri-apps/api/* and plugin-dialog).
// Test files wire it with vi.mock(...) factories that import from here, so this module must
// not import anything that imports a mocked module (the factory would wait on itself).
// Store resets live in ./reset.ts.
import { vi } from "vitest";
import type { AppState, GitChange, MenuAction, Project, SetupState, Thread, UnusedWorktree, WorktreeCleanReport } from "../../ipc/types";

type Handler = (event: { payload: unknown }) => void;

export interface Call {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

export const readySetup: SetupState = {
  status: "ready",
  claudePath: "/opt/homebrew/bin/claude",
  claudeVersion: "2.1.296",
  fixtureVersion: "2.1.296",
  versionMismatch: false,
  searchedPaths: [],
  envDegraded: false,
  message: null,
};

export const backend = {
  state: emptyState(),
  notice: null as string | null,
  setup: readySetup as SetupState,
  /** Directories that exist on "disk". */
  dirs: new Set<string>(),
  /** Regular files that exist on "disk". */
  files: new Set<string>(),
  /** terminalId -> whether its shell has a foreground child. */
  foreground: {} as Record<string, boolean>,
  calls: [] as Call[],
  listeners: {} as Record<string, Handler[]>,
  dragDrop: null as ((e: { payload: unknown }) => void) | null,
  /** Folders the OS opened with Speedy (`speedy .`) that the webview hasn't taken. */
  pendingOpens: [] as string[],
  /** The explorer's view of the selected project: relative path -> text (folders are implied). */
  projectFiles: {} as Record<string, string>,
  /** Top-level paths `explorer_list` flags as gitignored (and everything under them). */
  ignoredPaths: [] as string[],
  gitChanges: [] as GitChange[],
  worktreeUnused: [] as UnusedWorktree[],
  worktreeClean: { removed: [], skipped: [], deletedBranches: [] } as WorktreeCleanReport,
};

/** Direct children of `dir` in `backend.projectFiles`, folders first. */
function listProjectDir(dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const seen = new Map<string, boolean>();
  for (const path of Object.keys(backend.projectFiles)) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split("/");
    seen.set(name, (seen.get(name) ?? false) || rest.length > 0);
  }
  return [...seen]
    .map(([name, isDir]) => {
      const path = prefix + name;
      const ignored = backend.ignoredPaths.some((p) => path === p || path.startsWith(`${p}/`));
      return { name, path, isDir, ignored };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

export function emptyState(): AppState {
  return {
    version: 1,
    projects: [],
    groups: [],
    selectedThreadId: null,
    claudePathOverride: null,
    sidebarWidth: 260,
    notificationsEnabled: true,
    completionSound: null,
    activityPanelVisible: false,
  };
}

export const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  backend.calls.push({ cmd, args });
  switch (cmd) {
    case "state_load":
      return { state: structuredClone(backend.state), notice: backend.notice };
    case "state_save":
      backend.state = structuredClone(args!.state as AppState);
      return undefined;
    case "get_setup_state":
    case "recheck_setup":
      return backend.setup;
    case "paths_exist":
      return (args!.paths as string[]).map((p) =>
        p.endsWith("/") ? backend.dirs.has(p.slice(0, -1)) : backend.dirs.has(p) || backend.files.has(p),
      );
    case "pty_has_foreground_child":
      return backend.foreground[args!.terminalId as string] ?? false;
    case "sessions_list":
      return [];
    case "open_folders_take":
      return backend.pendingOpens.splice(0);
    case "explorer_list":
      return listProjectDir(args!.dir as string);
    case "explorer_read":
      return backend.projectFiles[args!.path as string];
    case "files_search": {
      const q = (args!.query as string).toLowerCase();
      return Object.keys(backend.projectFiles)
        .filter((p) => p.toLowerCase().includes(q))
        .map((path) => ({ path, isDir: false }));
    }
    case "explorer_write":
      backend.projectFiles[args!.path as string] = args!.content as string;
      return undefined;
    case "explorer_git_status":
      return backend.gitChanges;
    case "worktree_unused":
      return backend.worktreeUnused;
    case "worktree_clean":
      return backend.worktreeClean;
    case "explorer_git_diff":
      return { path: args!.path, isNewFile: false, unified: "--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n", baseFingerprint: "" };
    default:
      return undefined;
  }
});

export const coreMock = {
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
};

export const eventMock = {
  listen: vi.fn(async (event: string, handler: Handler) => {
    (backend.listeners[event] ??= []).push(handler);
    return () => {
      backend.listeners[event] = (backend.listeners[event] ?? []).filter((h) => h !== handler);
    };
  }),
};

export const webviewMock = {
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (e: { payload: unknown }) => void) => {
      backend.dragDrop = handler;
      return () => {
        if (backend.dragDrop === handler) backend.dragDrop = null;
      };
    },
  }),
};

export const dialog = {
  open: vi.fn(async (): Promise<string | string[] | null> => null),
  ask: vi.fn(async (): Promise<boolean> => true),
  message: vi.fn(async (): Promise<void> => {}),
};

export const dialogMock = {
  open: (...a: unknown[]) => (dialog.open as (...x: unknown[]) => Promise<unknown>)(...a),
  ask: (...a: unknown[]) => (dialog.ask as (...x: unknown[]) => Promise<unknown>)(...a),
  message: (...a: unknown[]) => (dialog.message as (...x: unknown[]) => Promise<unknown>)(...a),
};

export function emitMenu(action: MenuAction) {
  for (const h of backend.listeners.menu ?? []) h({ payload: action });
}

/** Simulates `speedy <folders>`: Rust queues them and emits `open-folders`. */
export function openFolders(...paths: string[]) {
  backend.pendingOpens.push(...paths);
  for (const h of backend.listeners["open-folders"] ?? []) h({ payload: null });
}

export const callsTo = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);
export const lastSaved = () => callsTo("state_save").at(-1)?.args?.state as AppState | undefined;

/** Reset the fake backend between tests (see ./reset.ts for the stores). */
export function resetFakeBackend(state: AppState = emptyState()) {
  backend.state = structuredClone(state);
  backend.notice = null;
  backend.setup = readySetup;
  backend.dirs = new Set(state.projects.map((p) => p.path));
  backend.files = new Set();
  backend.foreground = {};
  backend.calls = [];
  backend.listeners = {};
  backend.dragDrop = null;
  backend.pendingOpens = [];
  backend.projectFiles = {};
  backend.ignoredPaths = [];
  backend.gitChanges = [];
  backend.worktreeUnused = [];
  backend.worktreeClean = { removed: [], skipped: [], deletedBranches: [] };
  invoke.mockClear();
  dialog.open.mockReset().mockResolvedValue(null);
  dialog.ask.mockReset().mockResolvedValue(true);
  dialog.message.mockReset().mockResolvedValue(undefined);
}

let n = 0;
export function project(name: string, threads: Partial<Thread>[] = [{}], extra: Partial<Project> = {}): Project {
  n += 1;
  return {
    id: `p-${name}`,
    path: `/Users/me/${name}`,
    name,
    collapsed: false,
    threads: threads.map((t, i) => ({
      id: `${name}-t${i + 1}`,
      title: `${name} thread ${i + 1}`,
      sessionId: null,
      archived: false,
      createdAt: n,
      splitRatio: 0.65,
      terminalVisible: true,
      terminalMaximized: false,
      model: null,
      permissionMode: null,
      ...t,
    })),
    ...extra,
  };
}

export function stateWith(projects: Project[], selectedThreadId: string | null = projects[0]?.threads[0]?.id ?? null): AppState {
  return { ...emptyState(), projects, selectedThreadId };
}

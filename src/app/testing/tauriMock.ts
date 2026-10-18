// Test double for the Tauri IPC boundary (@tauri-apps/api/* and plugin-dialog).
// Test files wire it with vi.mock(...) factories that import from here, so this module must
// not import anything that imports a mocked module (the factory would wait on itself).
// Store resets live in ./reset.ts.
import { vi } from "vitest";
import type {
  AppState,
  ClientState,
  GitChange,
  HostEvent,
  HostProject,
  MenuAction,
  Project,
  SetupState,
  Thread,
  ThreadPatch,
  UnusedWorktree,
  WorktreeCleanReport,
} from "../../ipc/types";

type Handler = (event: { payload: unknown }) => void;

export interface Call {
  cmd: string;
  args: Record<string, unknown> | undefined;
  /** The host a host RPC went to. */
  host?: string;
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
  /** Every persisted view, after each client save or host change. */
  saves: [] as AppState[],
  /** SSH hosts besides This Mac, with the connection state their watch reports. */
  extraHosts: [] as { key: string; state: Record<string, unknown> }[],
  /** Setup state per host key; This Mac and unlisted hosts use `setup`. */
  setupByHost: {} as Record<string, unknown>,
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
  /** Host event channels from `host_subscribe`, by host key. */
  hostChannels: {} as Record<string, { onmessage: (e: HostEvent) => void }>,
  /** Thread event channels from `host_thread_subscribe`, by thread id. */
  threadChannels: {} as Record<string, { onmessage: (e: unknown) => void }>,
};

/** The fake host's view of `backend.state`'s projects on `host`. */
function hostProjects(state: AppState, host: string): HostProject[] {
  return state.projects.filter((p) => (p.hostKey ?? "local") === host).map((p) => ({
    id: p.id,
    path: p.path,
    name: p.name,
    scratch: p.scratch ?? false,
    threads: p.threads.map((t) => ({
      id: t.id,
      title: t.title,
      sessionId: t.sessionId,
      archived: t.archived,
      createdAt: t.createdAt,
      model: t.model,
      permissionMode: t.permissionMode,
      worktree: t.worktree ?? null,
      worktreeRequested: t.worktreeRequested ?? false,
      fork: t.fork ?? null,
      queue: [],
    })),
  }));
}

function clientOf(state: AppState): ClientState {
  return {
    version: 1,
    groups: state.groups,
    projects: state.projects.map((p) => ({ hostId: p.hostKey ?? "local", projectId: p.id, collapsed: p.collapsed, groupId: p.groupId ?? null })),
    threads: state.projects.flatMap((p) =>
      p.threads.map((t) => ({ threadId: t.id, splitRatio: t.splitRatio, terminalVisible: t.terminalVisible, terminalMaximized: t.terminalMaximized })),
    ),
    selectedThreadId: state.selectedThreadId,
    sidebarWidth: state.sidebarWidth,
    notificationsEnabled: state.notificationsEnabled,
    completionSound: state.completionSound,
    activityPanelVisible: state.activityPanelVisible,
    claudePathOverride: state.claudePathOverride,
  };
}

/** Folds a client.json save into the persisted view: order, prefs and layout, keeping host fields. */
function applyClientSave(c: ClientState) {
  const old = backend.state;
  const byId = new Map(old.projects.map((p) => [p.id, p]));
  const projects = c.projects.flatMap((cp) => {
    const p = byId.get(cp.projectId);
    if (!p) return [];
    const order = new Map(c.threads.map((t, i) => [t.threadId, i]));
    const layout = new Map(c.threads.map((t) => [t.threadId, t]));
    const threads = p.threads
      .map((t) => ({ ...t, ...(layout.get(t.id) ? { splitRatio: layout.get(t.id)!.splitRatio, terminalVisible: layout.get(t.id)!.terminalVisible, terminalMaximized: layout.get(t.id)!.terminalMaximized } : {}) }))
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    return [{ ...p, collapsed: cp.collapsed, groupId: cp.groupId, threads }];
  });
  backend.state = {
    ...old,
    projects,
    groups: c.groups,
    selectedThreadId: c.selectedThreadId,
    sidebarWidth: c.sidebarWidth,
    notificationsEnabled: c.notificationsEnabled,
    completionSound: c.completionSound,
    activityPanelVisible: c.activityPanelVisible,
    claudePathOverride: c.claudePathOverride,
  };
  backend.saves.push(structuredClone(backend.state));
}

/** The fake host's thread and project RPCs, applied to the persisted view. */
function hostRpc(method: string, a: Record<string, unknown>, host = "local"): unknown {
  const st = backend.state;
  const edit = (threadId: string, fn: (t: Thread) => Thread) => {
    st.projects = st.projects.map((p) => ({ ...p, threads: p.threads.map((t) => (t.id === threadId ? fn(t) : t)) }));
  };
  switch (method) {
    case "project_add":
      if (!st.projects.some((p) => p.id === a.id)) {
        st.projects = [...st.projects, { id: a.id as string, hostKey: host, path: a.path as string, name: a.name as string, collapsed: false, threads: [] }];
      }
      break;
    case "project_remove":
      st.projects = st.projects.filter((p) => p.id !== a.id);
      break;
    case "thread_create": {
      const t = a.thread as Partial<Thread> & { id: string; createdAt: number };
      const thread: Thread = {
        id: t.id,
        title: t.title ?? "New thread",
        sessionId: t.sessionId ?? null,
        archived: false,
        createdAt: t.createdAt,
        splitRatio: 0.65,
        terminalVisible: false,
        terminalMaximized: false,
        model: t.model ?? null,
        permissionMode: t.permissionMode ?? null,
        worktree: t.worktree ?? null,
        worktreeRequested: t.worktreeRequested ?? false,
        fork: t.fork ?? null,
      };
      st.projects = st.projects.map((p) => (p.id === a.projectId && !p.threads.some((x) => x.id === t.id) ? { ...p, threads: [...p.threads, thread] } : p));
      break;
    }
    case "thread_update": {
      const patch = a.patch as ThreadPatch;
      edit(a.threadId as string, (t) => ({
        ...t,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        ...(patch.worktreeRequested !== undefined ? { worktreeRequested: patch.worktreeRequested } : {}),
        ...(patch.clearWorktree ? { worktree: null } : {}),
      }));
      break;
    }
    default:
      return undefined;
  }
  backend.saves.push(structuredClone(backend.state));
  return undefined;
}

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

export const invoke = vi.fn(async (outer: string, outerArgs?: Record<string, unknown>): Promise<unknown> => {
  // A host RPC is recorded under its method name.
  const viaHost = outer === "host_call";
  const cmd = viaHost ? (outerArgs!.method as string) : outer;
  const args = viaHost ? (outerArgs!.params as Record<string, unknown>) : outerArgs;
  const host = viaHost ? (outerArgs!.host as string) : undefined;
  backend.calls.push({ cmd, args, host });
  switch (cmd) {
    case "client_state_load":
      return { state: clientOf(backend.state), notice: backend.notice };
    case "client_state_save":
      applyClientSave(args!.state as ClientState);
      return undefined;
    case "host_subscribe": {
      const channel = args!.onEvent as { onmessage: (e: HostEvent) => void };
      backend.hostChannels[args!.host as string] = channel;
      const snapshot = { epoch: 1, projects: hostProjects(backend.state, args!.host as string), statuses: {} };
      channel.onmessage({ kind: "host_snapshot", snapshot });
      return 1;
    }
    case "host_list":
      return [
        { key: "local", state: { state: "connected", host_id: "this-mac", agent_version: "test" }, update: null },
        ...backend.extraHosts.map((h) => ({ ...h, update: null })),
      ];
    case "host_watch": {
      const extra = backend.extraHosts.find((h) => h.key === args!.host);
      (args!.onState as { onmessage: (s: unknown) => void }).onmessage(extra?.state ?? { state: "connected", host_id: "this-mac", agent_version: "test" });
      return undefined;
    }
    case "home_dir":
      return "/Users/me";
    case "host_thread_subscribe":
      backend.threadChannels[args!.threadId as string] = args!.onEvent as { onmessage: (e: unknown) => void };
      return 1;
    case "host_pty_attach":
      return 1;
    case "project_add":
    case "project_remove":
    case "thread_create":
    case "thread_update":
      return hostRpc(cmd, args!, host);
    case "claude_start":
      return "idle";
    case "get_setup_state":
    case "recheck_setup":
      return (host && backend.setupByHost[host]) ?? backend.setup;
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
/** The latest persisted view: host fields from host RPCs plus client.json fields from saves. */
export const lastSaved = () => backend.saves.at(-1);

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
  backend.hostChannels = {};
  backend.threadChannels = {};
  backend.saves = [];
  backend.extraHosts = [];
  backend.setupByHost = {};
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
    hostKey: "local",
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

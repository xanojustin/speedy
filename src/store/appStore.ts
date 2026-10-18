// Projects, threads, selection, and layout: a merged view of each host's projects and threads
// (host-owned, KTD6) and the app's own preferences in `client.json` (groups, order, collapse,
// layout, selection, settings). A change to a host field goes to the host, which broadcasts it
// back to every client; a change to a preference is saved to `client.json`.
import { create } from "zustand";
import {
  clientStateLoad,
  clientStateSave,
  hostAdd,
  hostList,
  hostRemove,
  hostSubscribe,
  hostWatch,
  projectAdd,
  projectRemove,
  setHostLookup,
  threadCreate,
  threadUpdate,
  type NewThread,
} from "../ipc/commands";
import {
  GROUP_COLORS,
  LOCAL_HOST,
  type AppState,
  type ClientState,
  type Group,
  type GroupColor,
  type ConnState,
  type HostEvent,
  type HostInfo,
  type HostProject,
  type HostThread,
  type Project,
  type Thread,
  type ThreadPatch,
  type ThreadStatus,
} from "../ipc/types";
import { useThreadStore } from "./threadStore";

export interface AppStore extends AppState {
  loaded: boolean;
  /** This Mac first, then SSH hosts, with their connection state (R3). */
  hosts: HostInfo[];
  /** Set when the state file was corrupt and moved aside. */
  notice: string | null;
  /** The Settings dialog is open (not persisted). */
  settingsOpen: boolean;
  /** The file explorer panel is open (not persisted: it starts hidden). */
  explorerOpen: boolean;
  explorerWidth: number;
  /** A file the explorer should open, from a transcript link; the explorer takes it (not persisted). */
  explorerReveal: { path: string; line: number | null } | null;

  load(): Promise<void>;
  /** Applies one of `host`'s events (also used by tests). */
  applyHostEvent(host: string, event: HostEvent): void;
  /** Adds an SSH host from `~/.ssh/config` and follows it; rejects with why it couldn't connect. */
  addHost(alias: string): Promise<void>;
  /** Forgets an SSH host here; its agent and threads keep running there. */
  removeHost(key: string): Promise<void>;
  addProject(path: string, hostKey?: string): string; // returns the new thread id
  removeProject(projectId: string): void;
  moveProject(projectId: string, toIndex: number): void;
  setProjectCollapsed(projectId: string, collapsed: boolean): void;
  /** Files a project under a group; null ungroups it. */
  setProjectGroup(projectId: string, groupId: string | null): void;

  createGroup(name: string, hostKey?: string): string;
  renameGroup(groupId: string, name: string): void;
  /** Deletes the group; its projects become ungrouped. */
  deleteGroup(groupId: string): void;
  moveGroup(groupId: string, toIndex: number): void;
  setGroupCollapsed(groupId: string, collapsed: boolean): void;
  setGroupColor(groupId: string, color: GroupColor): void;

  createThread(projectId: string, init?: Partial<Pick<Thread, "title" | "sessionId" | "worktree" | "fork">>): string;
  updateThread(threadId: string, patch: Partial<Omit<Thread, "id">>): void;
  archiveThread(threadId: string): void;
  restoreThread(threadId: string): void;
  moveThread(threadId: string, toIndex: number): void;
  selectThread(threadId: string | null): void;
  setSidebarWidth(width: number): void;
  setClaudePathOverride(path: string | null): void;
  updateSettings(patch: Partial<Pick<AppState, "notificationsEnabled" | "completionSound" | "activityPanelVisible">>): void;
  setSettingsOpen(open: boolean): void;
  setExplorerOpen(open: boolean): void;
  setExplorerWidth(width: number): void;
  /** Opens the explorer on `path` (relative to the thread's folder, or absolute) at `line`. */
  revealInExplorer(path: string, line: number | null): void;
  /** Hands the pending reveal to the explorer and clears it. */
  takeExplorerReveal(): { path: string; line: number | null } | null;
  dismissNotice(): void;
}

export const newId = () => crypto.randomUUID();

export function makeThread(init?: Partial<Thread>): Thread {
  return {
    id: newId(),
    title: "New thread",
    sessionId: null,
    archived: false,
    createdAt: Date.now(),
    splitRatio: 0.65,
    terminalVisible: false,
    terminalMaximized: false,
    model: null,
    permissionMode: null,
    worktree: null,
    worktreeRequested: false,
    ...init,
  };
}

function basename(path: string) {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** The app's half of the state, for `client.json`. */
const clientSnapshot = (s: AppStore): ClientState => ({
  version: 1,
  groups: s.groups,
  projects: s.projects.map((p) => ({ hostId: p.hostKey, projectId: p.id, collapsed: p.collapsed, groupId: p.groupId ?? null })),
  threads: s.projects.flatMap((p) =>
    p.threads.map((t) => ({ threadId: t.id, splitRatio: t.splitRatio, terminalVisible: t.terminalVisible, terminalMaximized: t.terminalMaximized })),
  ),
  selectedThreadId: s.selectedThreadId,
  sidebarWidth: s.sidebarWidth,
  notificationsEnabled: s.notificationsEnabled,
  completionSound: s.completionSound,
  activityPanelVisible: s.activityPanelVisible,
  claudePathOverride: s.claudePathOverride,
});

/** Layout prefs for threads the client hasn't seen yet. */
const THREAD_LAYOUT = { splitRatio: 0.65, terminalVisible: false, terminalMaximized: false };

/** A host thread with this client's layout for it (or the defaults). */
function mergeThread(host: HostThread, prev: Thread | undefined, client?: ClientState["threads"][number]): Thread {
  const layout = prev ?? client ?? THREAD_LAYOUT;
  return {
    id: host.id,
    title: host.title,
    sessionId: host.sessionId,
    archived: host.archived,
    createdAt: host.createdAt,
    model: host.model,
    permissionMode: host.permissionMode,
    worktree: host.worktree,
    worktreeRequested: host.worktreeRequested,
    fork: host.fork,
    splitRatio: layout.splitRatio,
    terminalVisible: layout.terminalVisible,
    terminalMaximized: layout.terminalMaximized,
  };
}

/** Threads in this client's order: known ones as before, new ones after. */
function mergeThreads(host: HostThread[], prev: Thread[], client: ClientState | null): Thread[] {
  const order = new Map(prev.map((t, i) => [t.id, i]));
  if (!prev.length && client) client.threads.forEach((t, i) => order.set(t.threadId, i));
  const prefs = new Map(client?.threads.map((t) => [t.threadId, t]));
  return host
    .map((t) => mergeThread(t, prev.find((p) => p.id === t.id), prefs.get(t.id)))
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
}

function mergeProject(hostKey: string, host: HostProject, prev: Project | undefined, client: ClientState | null): Project {
  const pref = client?.projects.find((p) => p.hostId === hostKey && p.projectId === host.id);
  return {
    id: host.id,
    hostKey,
    path: host.path,
    name: host.name,
    scratch: host.scratch,
    collapsed: prev?.collapsed ?? pref?.collapsed ?? false,
    groupId: prev ? prev.groupId : (pref?.groupId ?? null),
    threads: mergeThreads(host.threads, prev?.threads ?? [], client),
  };
}

/** Replaces `hostKey`'s projects, keeping this client's order and prefs. */
function mergeHost(projects: Project[], hostKey: string, host: HostProject[], client: ClientState | null): Project[] {
  const others = projects.filter((p) => p.hostKey !== hostKey);
  const merged = host.map((hp) => mergeProject(hostKey, hp, projects.find((p) => p.hostKey === hostKey && p.id === hp.id), client));
  const order = new Map(projects.map((p, i) => [`${p.hostKey}/${p.id}`, i]));
  client?.projects.forEach((p, i) => {
    const key = `${p.hostId}/${p.projectId}`;
    if (!order.has(key)) order.set(key, i);
  });
  return [...others, ...merged].sort((a, b) => (order.get(`${a.hostKey}/${a.id}`) ?? Infinity) - (order.get(`${b.hostKey}/${b.id}`) ?? Infinity));
}

function toHostThread(t: Thread): HostThread {
  return {
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
  };
}

/** The host's half of a thread patch; layout fields stay with the client. */
function hostPatch(patch: Partial<Omit<Thread, "id">>): ThreadPatch | null {
  const out: ThreadPatch = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.archived !== undefined) out.archived = patch.archived;
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.permissionMode !== undefined) out.permissionMode = patch.permissionMode;
  if (patch.worktreeRequested !== undefined) out.worktreeRequested = patch.worktreeRequested;
  if (patch.worktree === null) out.clearWorktree = true;
  return Object.keys(out).length ? out : null;
}

/** Host calls fail when the host is offline; the next host snapshot shows what actually happened. */
const report = (what: string) => (err: unknown) => console.warn(`${what} failed`, err);

const mapThreads = (projects: Project[], threadId: string, fn: (t: Thread) => Thread) =>
  projects.map((p) => (p.threads.some((t) => t.id === threadId) ? { ...p, threads: p.threads.map((t) => (t.id === threadId ? fn(t) : t)) } : p));

/** The first palette color no group uses yet, cycling once all are taken. */
function nextGroupColor(groups: Group[]): GroupColor {
  const used = new Set(groups.map((g) => g.color));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length];
}

/** Gives groups saved without a color (or with an unknown one) a palette color. */
function withColors(groups: Group[]): Group[] {
  return groups.reduce<Group[]>(
    (done, g) => [...done, GROUP_COLORS.includes(g.color as GroupColor) ? g : { ...g, color: nextGroupColor(done) }],
    [],
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from === to) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

export const useAppStore = create<AppStore>((set, get) => {
  /** Applies a change and saves the client's half. */
  const commit = (fn: (s: AppStore) => Partial<AppStore>) => {
    set(fn);
    const s = get();
    if (s.loaded) void clientStateSave(clientSnapshot(s)).catch(() => {});
  };
  /** `client.json` as loaded, to place projects and threads as hosts report them. */
  let client: ClientState | null = null;

  /** Follows a host's events and connection state. */
  const follow = async (key: string) => {
    await hostWatch(key, (state: ConnState) => set((s) => ({ hosts: s.hosts.map((h) => (h.key === key ? { ...h, state } : h)) })));
    await hostSubscribe(key, (event) => get().applyHostEvent(key, event));
  };

  return {
    version: 1,
    projects: [],
    hosts: [{ key: LOCAL_HOST, state: { state: "connecting" }, update: null }],
    groups: [],
    selectedThreadId: null,
    claudePathOverride: null,
    sidebarWidth: 260,
    notificationsEnabled: true,
    completionSound: null,
    activityPanelVisible: false,
    loaded: false,
    notice: null,
    settingsOpen: false,
    explorerOpen: false,
    explorerReveal: null,
    explorerWidth: 380,

    async load() {
      const { state, notice } = await clientStateLoad();
      client = state;
      setHostLookup(({ threadId, path }) => {
        const s = get();
        if (threadId) return findThread(s, threadId)?.project.hostKey;
        if (path) return s.projects.find((p) => path === p.path || path.startsWith(`${p.path}/`))?.hostKey;
        return undefined;
      });
      set({
        groups: withColors(state.groups ?? []),
        selectedThreadId: state.selectedThreadId,
        sidebarWidth: state.sidebarWidth,
        notificationsEnabled: state.notificationsEnabled,
        completionSound: state.completionSound,
        activityPanelVisible: state.activityPanelVisible,
        claudePathOverride: state.claudePathOverride,
        notice,
        loaded: true,
      });
      const hosts = (await hostList().catch(() => null)) ?? [];
      set({ hosts: hosts.some((h) => h.key === LOCAL_HOST) ? hosts : [{ key: LOCAL_HOST, state: { state: "connecting" }, update: null }, ...hosts] });
      await Promise.all(get().hosts.map((h) => follow(h.key)));
    },

    async addHost(alias) {
      const info = await hostAdd(alias);
      set((s) => ({ hosts: [...s.hosts.filter((h) => h.key !== info.key), info] }));
      await follow(info.key);
    },

    async removeHost(key) {
      await hostRemove(key);
      commit((s) => ({
        hosts: s.hosts.filter((h) => h.key !== key),
        projects: s.projects.filter((p) => p.hostKey !== key),
        groups: s.groups.filter((g) => (g.hostKey ?? LOCAL_HOST) !== key),
      }));
    },

    applyHostEvent(host, event) {
      const statuses = (entries: [string, ThreadStatus][]) => {
        const dispatch = useThreadStore.getState().dispatch;
        for (const [id, status] of entries) dispatch(id, { kind: "local_status", status });
      };
      switch (event.kind) {
        case "host_snapshot":
          set((s) => ({ projects: mergeHost(s.projects, host, event.snapshot.projects, client) }));
          statuses(Object.entries(event.snapshot.statuses));
          break;
        case "project_upserted":
          set((s) => {
            const prev = s.projects.find((p) => p.hostKey === host && p.id === event.project.id);
            const project = mergeProject(host, { ...event.project, threads: prev ? prev.threads.map(toHostThread) : event.project.threads }, prev, client);
            return { projects: prev ? s.projects.map((p) => (p === prev ? project : p)) : [...s.projects, project] };
          });
          break;
        case "project_removed":
          set((s) => ({ projects: s.projects.filter((p) => !(p.hostKey === host && p.id === event.id)) }));
          break;
        case "thread_upserted":
          set((s) => ({
            projects: s.projects.map((p) => {
              if (p.hostKey !== host || p.id !== event.projectId) return p;
              const prev = p.threads.find((t) => t.id === event.thread.id);
              const prefs = client?.threads.find((t) => t.threadId === event.thread.id);
              const thread = mergeThread(event.thread, prev, prefs);
              return { ...p, threads: prev ? p.threads.map((t) => (t === prev ? thread : t)) : [...p.threads, thread] };
            }),
          }));
          break;
        case "thread_removed":
          set((s) => ({ projects: s.projects.map((p) => (p.hostKey === host ? { ...p, threads: p.threads.filter((t) => t.id !== event.id) } : p)) }));
          break;
        case "thread_status":
          statuses([[event.id, event.status]]);
          break;
        case "subscribe_failed":
          console.warn(`subscribing to host ${host} failed: ${event.error}`);
          break;
      }
    },

    addProject(path, hostKey = LOCAL_HOST) {
      const existing = get().projects.find((p) => p.hostKey === hostKey && p.path === path);
      if (existing) {
        const live = existing.threads.find((t) => !t.archived);
        const id = live?.id ?? get().createThread(existing.id);
        get().selectThread(id);
        return id;
      }
      const thread = makeThread();
      const project: Project = { id: newId(), hostKey, path, name: basename(path), collapsed: false, threads: [thread] };
      commit((s) => ({ projects: [...s.projects, project], selectedThreadId: thread.id }));
      void projectAdd(hostKey, { id: project.id, path, name: project.name })
        .then(() => threadCreate(hostKey, project.id, { id: thread.id, createdAt: thread.createdAt }))
        .catch(report("adding the project"));
      return thread.id;
    },

    removeProject(projectId) {
      const removed = get().projects.find((p) => p.id === projectId);
      if (removed) void projectRemove(removed.hostKey, projectId).catch(report("removing the project"));
      commit((s) => {
        const project = s.projects.find((p) => p.id === projectId);
        const selectedGone = project?.threads.some((t) => t.id === s.selectedThreadId);
        return {
          projects: s.projects.filter((p) => p.id !== projectId),
          selectedThreadId: selectedGone ? null : s.selectedThreadId,
        };
      });
    },

    moveProject(projectId, toIndex) {
      commit((s) => ({ projects: move(s.projects, s.projects.findIndex((p) => p.id === projectId), toIndex) }));
    },

    setProjectCollapsed(projectId, collapsed) {
      commit((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, collapsed } : p)) }));
    },

    setProjectGroup(projectId, groupId) {
      commit((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, groupId } : p)) }));
    },

    createGroup(name, hostKey = LOCAL_HOST) {
      const group: Group = { id: newId(), hostKey, name, collapsed: false, color: nextGroupColor(get().groups) };
      commit((s) => ({ groups: [...s.groups, group] }));
      return group.id;
    },

    renameGroup(groupId, name) {
      commit((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, name } : g)) }));
    },

    deleteGroup(groupId) {
      commit((s) => ({
        groups: s.groups.filter((g) => g.id !== groupId),
        projects: s.projects.map((p) => (p.groupId === groupId ? { ...p, groupId: null } : p)),
      }));
    },

    moveGroup(groupId, toIndex) {
      commit((s) => ({ groups: move(s.groups, s.groups.findIndex((g) => g.id === groupId), toIndex) }));
    },

    setGroupCollapsed(groupId, collapsed) {
      commit((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)) }));
    },

    setGroupColor(groupId, color) {
      commit((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, color } : g)) }));
    },

    createThread(projectId, init) {
      const thread = makeThread(init);
      const project = get().projects.find((p) => p.id === projectId);
      if (project) {
        const created: NewThread = {
          id: thread.id,
          title: init?.title ?? null,
          createdAt: thread.createdAt,
          sessionId: thread.sessionId,
          worktree: thread.worktree ?? null,
          fork: thread.fork ?? null,
        };
        void threadCreate(project.hostKey, projectId, created).catch(report("creating the thread"));
      }
      commit((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? { ...p, collapsed: false, threads: [...p.threads, thread] } : p)),
        selectedThreadId: thread.id,
      }));
      return thread.id;
    },

    updateThread(threadId, patch) {
      // A patch that changes nothing (e.g. session_bound re-firing with the same id) is not a new
      // state: no re-render for subscribers and no state_save.
      const current = findThread(get(), threadId)?.thread;
      if (current && (Object.keys(patch) as (keyof typeof patch)[]).every((k) => Object.is(current[k], patch[k]))) return;
      const forHost = hostPatch(patch);
      if (forHost) void threadUpdate(threadId, forHost).catch(report("updating the thread"));
      commit((s) => ({ projects: mapThreads(s.projects, threadId, (t) => ({ ...t, ...patch })) }));
    },

    archiveThread(threadId) {
      void threadUpdate(threadId, { archived: true }).catch(report("archiving the thread"));
      commit((s) => {
        const projects = mapThreads(s.projects, threadId, (t) => ({ ...t, archived: true }));
        let selectedThreadId = s.selectedThreadId;
        if (selectedThreadId === threadId) {
          const project = projects.find((p) => p.threads.some((t) => t.id === threadId));
          selectedThreadId = project?.threads.find((t) => !t.archived)?.id ?? null;
        }
        return { projects, selectedThreadId };
      });
    },

    restoreThread(threadId) {
      void threadUpdate(threadId, { archived: false }).catch(report("restoring the thread"));
      commit((s) => ({ projects: mapThreads(s.projects, threadId, (t) => ({ ...t, archived: false })), selectedThreadId: threadId }));
    },

    moveThread(threadId, toIndex) {
      commit((s) => ({
        projects: s.projects.map((p) => {
          const from = p.threads.findIndex((t) => t.id === threadId);
          return from < 0 ? p : { ...p, threads: move(p.threads, from, toIndex) };
        }),
      }));
    },

    selectThread(threadId) {
      commit(() => ({ selectedThreadId: threadId }));
    },

    setSidebarWidth(width) {
      commit(() => ({ sidebarWidth: width }));
    },

    setClaudePathOverride(path) {
      commit(() => ({ claudePathOverride: path }));
    },

    updateSettings(patch) {
      commit(() => patch);
    },

    setSettingsOpen(open) {
      set({ settingsOpen: open });
    },

    setExplorerOpen(open) {
      set({ explorerOpen: open });
    },

    setExplorerWidth(width) {
      set({ explorerWidth: width });
    },

    revealInExplorer(path, line) {
      set({ explorerOpen: true, explorerReveal: { path, line } });
    },

    takeExplorerReveal() {
      const reveal = get().explorerReveal;
      if (reveal) set({ explorerReveal: null });
      return reveal;
    },

    dismissNotice() {
      set({ notice: null });
    },
  };
});

/** The project and thread for a thread id. */
/** Where a thread works: its own worktree when it has one, else the project folder. */
export function threadCwd(project: Pick<Project, "path">, thread: Pick<Thread, "worktree">): string {
  return thread.worktree?.path ?? project.path;
}

export function findThread(state: Pick<AppState, "projects">, threadId: string | null) {
  if (!threadId) return null;
  for (const project of state.projects) {
    const thread = project.threads.find((t) => t.id === threadId);
    if (thread) return { project, thread };
  }
  return null;
}

export interface SidebarSection {
  /** null for the Chats project and the ungrouped projects, which come first. */
  group: Group | null;
  projects: Project[];
}

/** Projects as the sidebar shows them: Chats, then ungrouped, then each group in order. */
export function sidebarSections(state: Pick<AppState, "projects" | "groups">): SidebarSection[] {
  const groups = state.groups ?? [];
  const known = new Set(groups.map((g) => g.id));
  const folders = state.projects.filter((p) => !p.scratch);
  return [
    { group: null, projects: state.projects.filter((p) => p.scratch) },
    { group: null, projects: folders.filter((p) => !p.groupId || !known.has(p.groupId)) },
    ...groups.map((group) => ({ group, projects: folders.filter((p) => p.groupId === group.id) })),
  ];
}

export interface HostSection {
  host: HostInfo;
  sections: SidebarSection[];
}

/** The sidebar per host (R13): This Mac first, then SSH hosts, each with its own Chats and groups. */
export function hostSections(state: Pick<AppStore, "projects" | "groups" | "hosts">): HostSection[] {
  return state.hosts.map((host) => ({
    host,
    sections: sidebarSections({
      projects: state.projects.filter((p) => p.hostKey === host.key),
      groups: state.groups.filter((g) => (g.hostKey ?? LOCAL_HOST) === host.key),
    }),
  }));
}

/** Non-archived threads in sidebar order (Cmd+1–9 targets). */
export function visibleThreads(state: Pick<AppStore, "projects" | "groups" | "hosts">) {
  return hostSections(state).flatMap((h) => h.sections).flatMap((sec) =>
    sec.group?.collapsed ? [] : sec.projects.flatMap((p) => (p.collapsed ? [] : p.threads.filter((t) => !t.archived))),
  );
}

/** Resolves once `key` is connected; rejects with its last error after `ms`. */
export function waitForHost(key: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => hostConnected(useAppStore.getState(), key);
    if (done()) return resolve();
    const timer = setTimeout(() => {
      unsub();
      const state = useAppStore.getState().hosts.find((h) => h.key === key)?.state;
      reject(new Error(state?.state === "reconnecting" ? state.error : `${hostLabel(key)} didn't connect`));
    }, ms);
    const unsub = useAppStore.subscribe(() => {
      if (!done()) return;
      clearTimeout(timer);
      unsub();
      resolve();
    });
  });
}

/** A host's display name. */
export const hostLabel = (key: string) => (key === LOCAL_HOST ? "This Mac" : key);

/** Whether a host's agent is connected. */
export const hostConnected = (state: Pick<AppStore, "hosts">, key: string) =>
  state.hosts.find((h) => h.key === key)?.state.state === "connected";

/** A host's state for a banner or header label (R3). */
export function hostStateLabel(host: HostInfo | undefined): string {
  if (!host) return "Offline";
  if (host.update === "blocked") return "Needs restart";
  if (host.update === "pending") return "Update pending";
  switch (host.state.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
  }
}

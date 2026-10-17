// Projects, threads, selection, and layout: Speedy's own persisted state (KTD6).
// Every mutation schedules a save through the Rust store (which debounces and writes atomically).
import { create } from "zustand";
import { stateLoad, stateSave } from "../ipc/commands";
import { GROUP_COLORS, type AppState, type Group, type GroupColor, type Project, type Thread } from "../ipc/types";

export interface AppStore extends AppState {
  loaded: boolean;
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
  addProject(path: string): string; // returns the new thread id
  removeProject(projectId: string): void;
  moveProject(projectId: string, toIndex: number): void;
  setProjectCollapsed(projectId: string, collapsed: boolean): void;
  /** Files a project under a group; null ungroups it. */
  setProjectGroup(projectId: string, groupId: string | null): void;

  createGroup(name: string): string;
  renameGroup(groupId: string, name: string): void;
  /** Deletes the group; its projects become ungrouped. */
  deleteGroup(groupId: string): void;
  moveGroup(groupId: string, toIndex: number): void;
  setGroupCollapsed(groupId: string, collapsed: boolean): void;
  setGroupColor(groupId: string, color: GroupColor): void;

  createThread(projectId: string, init?: Partial<Pick<Thread, "title" | "sessionId" | "worktree">>): string;
  updateThread(threadId: string, patch: Partial<Omit<Thread, "id">>): void;
  archiveThread(threadId: string): void;
  restoreThread(threadId: string): void;
  moveThread(threadId: string, toIndex: number): void;
  selectThread(threadId: string | null): void;
  setSidebarWidth(width: number): void;
  setClaudePathOverride(path: string | null): void;
  updateSettings(patch: Partial<Pick<AppState, "notificationsEnabled" | "completionSound">>): void;
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

const snapshot = (s: AppStore): AppState => ({
  version: s.version,
  projects: s.projects,
  groups: s.groups,
  selectedThreadId: s.selectedThreadId,
  claudePathOverride: s.claudePathOverride,
  sidebarWidth: s.sidebarWidth,
  notificationsEnabled: s.notificationsEnabled,
  completionSound: s.completionSound,
});

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
  const commit = (fn: (s: AppStore) => Partial<AppStore>) => {
    set(fn);
    const s = get();
    if (s.loaded) void stateSave(snapshot(s)).catch(() => {});
  };

  return {
    version: 1,
    projects: [],
    groups: [],
    selectedThreadId: null,
    claudePathOverride: null,
    sidebarWidth: 260,
    notificationsEnabled: true,
    completionSound: null,
    loaded: false,
    notice: null,
    settingsOpen: false,
    explorerOpen: false,
    explorerReveal: null,
    explorerWidth: 380,

    async load() {
      const { state, notice } = await stateLoad();
      set({ ...state, groups: withColors(state.groups ?? []), notice, loaded: true });
    },

    addProject(path) {
      const existing = get().projects.find((p) => p.path === path);
      if (existing) {
        const live = existing.threads.find((t) => !t.archived);
        const id = live?.id ?? get().createThread(existing.id);
        get().selectThread(id);
        return id;
      }
      const thread = makeThread();
      const project: Project = { id: newId(), path, name: basename(path), collapsed: false, threads: [thread] };
      commit((s) => ({ projects: [...s.projects, project], selectedThreadId: thread.id }));
      return thread.id;
    },

    removeProject(projectId) {
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

    createGroup(name) {
      const group: Group = { id: newId(), name, collapsed: false, color: nextGroupColor(get().groups) };
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
      commit((s) => ({ projects: mapThreads(s.projects, threadId, (t) => ({ ...t, ...patch })) }));
    },

    archiveThread(threadId) {
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

/** Non-archived threads in sidebar order (Cmd+1–9 targets). */
export function visibleThreads(state: Pick<AppState, "projects" | "groups">) {
  return sidebarSections(state).flatMap((sec) =>
    sec.group?.collapsed ? [] : sec.projects.flatMap((p) => (p.collapsed ? [] : p.threads.filter((t) => !t.archived))),
  );
}

// Projects, threads, selection, and layout: Speedy's own persisted state (KTD6).
// Every mutation schedules a save through the Rust store (which debounces and writes atomically).
import { create } from "zustand";
import { stateLoad, stateSave } from "../ipc/commands";
import type { AppState, Project, Thread } from "../ipc/types";

export interface AppStore extends AppState {
  loaded: boolean;
  /** Set when the state file was corrupt and moved aside. */
  notice: string | null;
  /** The Settings dialog is open (not persisted). */
  settingsOpen: boolean;

  load(): Promise<void>;
  addProject(path: string): string; // returns the new thread id
  removeProject(projectId: string): void;
  moveProject(projectId: string, toIndex: number): void;
  setProjectCollapsed(projectId: string, collapsed: boolean): void;

  createThread(projectId: string, init?: Partial<Pick<Thread, "title" | "sessionId">>): string;
  updateThread(threadId: string, patch: Partial<Omit<Thread, "id">>): void;
  archiveThread(threadId: string): void;
  restoreThread(threadId: string): void;
  moveThread(threadId: string, toIndex: number): void;
  selectThread(threadId: string | null): void;
  setSidebarWidth(width: number): void;
  setClaudePathOverride(path: string | null): void;
  updateSettings(patch: Partial<Pick<AppState, "notificationsEnabled" | "completionSound">>): void;
  setSettingsOpen(open: boolean): void;
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
    terminalVisible: true,
    terminalMaximized: false,
    model: null,
    permissionMode: null,
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
  selectedThreadId: s.selectedThreadId,
  claudePathOverride: s.claudePathOverride,
  sidebarWidth: s.sidebarWidth,
  notificationsEnabled: s.notificationsEnabled,
  completionSound: s.completionSound,
});

const mapThreads = (projects: Project[], threadId: string, fn: (t: Thread) => Thread) =>
  projects.map((p) => (p.threads.some((t) => t.id === threadId) ? { ...p, threads: p.threads.map((t) => (t.id === threadId ? fn(t) : t)) } : p));

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
    selectedThreadId: null,
    claudePathOverride: null,
    sidebarWidth: 260,
    notificationsEnabled: true,
    completionSound: null,
    loaded: false,
    notice: null,
    settingsOpen: false,

    async load() {
      const { state, notice } = await stateLoad();
      set({ ...state, notice, loaded: true });
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

    dismissNotice() {
      set({ notice: null });
    },
  };
});

/** The project and thread for a thread id. */
export function findThread(state: Pick<AppState, "projects">, threadId: string | null) {
  if (!threadId) return null;
  for (const project of state.projects) {
    const thread = project.threads.find((t) => t.id === threadId);
    if (thread) return { project, thread };
  }
  return null;
}

/** Non-archived threads in sidebar order (Cmd+1–9 targets). */
export function visibleThreads(state: Pick<AppState, "projects">) {
  return state.projects.flatMap((p) => (p.collapsed ? [] : p.threads.filter((t) => !t.archived)));
}

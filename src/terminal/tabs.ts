// Terminal tabs per thread, like VS Code's terminal list. Not persisted: shells don't survive a
// restart, so a thread always reopens with one terminal. A thread's first terminal uses the
// thread id as its terminal id; later ones are `<threadId>:<n>`.
import { create } from "zustand";

export interface ThreadTerminals {
  ids: string[];
  active: string;
  /** Suffix for the next terminal id. */
  next: number;
}

interface TabsStore {
  byThread: Record<string, ThreadTerminals>;
  /** Titles set by the shell (OSC 0/2), by terminal id. */
  titles: Record<string, string>;
  /** Adds a terminal, makes it active, and returns its id. */
  add(threadId: string): string;
  setActive(threadId: string, terminalId: string): void;
  /** Drops a terminal; the last one is replaced by a fresh id. Returns whether it was the last. */
  remove(threadId: string, terminalId: string): boolean;
  /** Forgets the thread's tabs and returns its terminal ids. */
  forgetThread(threadId: string): string[];
  setTitle(terminalId: string, title: string): void;
}

// Cached so a selector returns the same object until the thread's tabs actually change.
const defaults = new Map<string, ThreadTerminals>();
function initial(threadId: string): ThreadTerminals {
  let t = defaults.get(threadId);
  if (!t) defaults.set(threadId, (t = { ids: [threadId], active: threadId, next: 2 }));
  return t;
}

/** The thread's terminals; a thread nobody has touched has its one default terminal. */
export const terminalsOf = (byThread: Record<string, ThreadTerminals>, threadId: string): ThreadTerminals =>
  byThread[threadId] ?? initial(threadId);

/** Fallback tab label, numbered by id so labels stay put when other tabs close. */
export function terminalLabel(threadId: string, terminalId: string): string {
  const n = terminalId === threadId ? 1 : Number(terminalId.slice(threadId.length + 1));
  return `Terminal ${n}`;
}

export const useTerminalTabs = create<TabsStore>((set, get) => ({
  byThread: {},
  titles: {},

  add(threadId) {
    const t = terminalsOf(get().byThread, threadId);
    const id = `${threadId}:${t.next}`;
    set((s) => ({ byThread: { ...s.byThread, [threadId]: { ids: [...t.ids, id], active: id, next: t.next + 1 } } }));
    return id;
  },

  setActive(threadId, terminalId) {
    const t = terminalsOf(get().byThread, threadId);
    if (!t.ids.includes(terminalId) || t.active === terminalId) return;
    set((s) => ({ byThread: { ...s.byThread, [threadId]: { ...t, active: terminalId } } }));
  },

  remove(threadId, terminalId) {
    const t = terminalsOf(get().byThread, threadId);
    const at = t.ids.indexOf(terminalId);
    if (at < 0) return false;
    const ids = t.ids.filter((id) => id !== terminalId);
    const last = ids.length === 0;
    let next = t.next;
    if (last) ids.push(`${threadId}:${next++}`);
    // Like VS Code, closing the active tab activates its neighbour.
    const active = t.active === terminalId ? ids[Math.min(at, ids.length - 1)] : t.active;
    set((s) => {
      const titles = { ...s.titles };
      delete titles[terminalId];
      return { byThread: { ...s.byThread, [threadId]: { ids, active, next } }, titles };
    });
    return last;
  },

  forgetThread(threadId) {
    const { ids } = terminalsOf(get().byThread, threadId);
    set((s) => {
      const byThread = { ...s.byThread };
      delete byThread[threadId];
      const titles = { ...s.titles };
      for (const id of ids) delete titles[id];
      return { byThread, titles };
    });
    return ids;
  },

  setTitle(terminalId, title) {
    if (get().titles[terminalId] === title) return;
    set((s) => ({ titles: { ...s.titles, [terminalId]: title } }));
  },
}));

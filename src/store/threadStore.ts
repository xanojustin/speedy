// U8: per-thread chat runtime (status, transcript blocks, pending permissions, queue).
// Every thread's events are reduced here whether or not it is visible (KTD2); only rendering is
// limited to the selected thread. IO lives in `runtime.ts`; this module is state only.
//
// Streaming: channel events arrive one per token. `queueThreadEvent` buffers them and applies
// everything buffered with one store update per animation frame, folding with `reduce` in arrival
// order (each with its own arrival time), so the state after a flush equals applying the events one
// by one. Anything that reads or writes a thread's runtime imperatively (`dispatch`, `getRuntime`)
// first applies that thread's buffered events, so ordering against local actions is preserved.
import { create } from "zustand";
import { initialRuntime, reduce, type ThreadAction, type ThreadRuntime } from "./reducer";

export type {
  PendingPermission,
  QueuedMessage,
  TaskProgress,
  ThreadAction,
  ThreadRuntime,
  TodoItem,
  ToolBlock,
  ToolResultView,
  ToolStatus,
  ViewBlock,
} from "./reducer";

export interface ThreadStoreState {
  threads: Record<string, ThreadRuntime>;
  /** Applies one action to a thread's runtime (creating it on first use), after any buffered events. */
  dispatch(threadId: string, action: ThreadAction): void;
}

interface Pending {
  action: ThreadAction;
  now: number;
}

/** Buffered channel events per thread, in arrival order. */
const pending = new Map<string, Pending[]>();

/** Folds `actions` into `threads`; returns `threads` itself when no runtime changed. */
function applyAll(threads: Record<string, ThreadRuntime>, batches: Iterable<[string, Pending[]]>): Record<string, ThreadRuntime> {
  let next = threads;
  for (const [threadId, list] of batches) {
    const cur = threads[threadId];
    let rt = cur ?? initialRuntime();
    for (const p of list) rt = reduce(rt, p.action, p.now);
    // Ignored events on an existing thread are a no-op; the first event for a thread creates it.
    if (cur && rt === cur) continue;
    if (next === threads) next = { ...threads };
    next[threadId] = rt;
  }
  return next;
}

/** Removes and returns the buffered events for one thread (or all threads). */
function take(threadId?: string): [string, Pending[]][] {
  if (threadId === undefined) {
    const all = [...pending.entries()];
    pending.clear();
    return all;
  }
  const list = pending.get(threadId);
  if (!list) return [];
  pending.delete(threadId);
  return [[threadId, list]];
}

export const useThreadStore = create<ThreadStoreState>((set) => ({
  threads: {},
  dispatch(threadId, action) {
    const batch = take(threadId);
    const entry: [string, Pending[]] = [threadId, [...(batch[0]?.[1] ?? []), { action, now: Date.now() }]];
    set((s) => {
      const threads = applyAll(s.threads, [entry]);
      return threads === s.threads ? s : { threads };
    });
  },
}));

// ---------- per-frame batching ----------

/** Vitest drives the store synchronously and asserts right after each event; batching is opt-in there. */
let batching = import.meta.env?.MODE !== "test";
let rafId: number | null = null;
let timerId: ReturnType<typeof setTimeout> | null = null;
/** When the pending flush was scheduled (performance.now(); Date.now() stamps arrivals). */
let scheduledAt = 0;

/** Backstop for a frame that never comes (window hidden after the frame was requested). */
const FALLBACK_MS = 16;
const BACKSTOP_MS = 100;
/**
 * A scheduled flush this late was lost: WebKit can drop both the frame and the timer while the
 * machine sleeps, and the stale ids would otherwise block every later schedule.
 */
const STALE_MS = 1000;

function cancelScheduled() {
  if (rafId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
  if (timerId !== null) clearTimeout(timerId);
  rafId = null;
  timerId = null;
}

function schedule() {
  if (rafId !== null || timerId !== null) {
    if (performance.now() - scheduledAt < STALE_MS) return;
    cancelScheduled();
  }
  scheduledAt = performance.now();
  const visible = typeof document === "undefined" || !document.hidden;
  if (typeof requestAnimationFrame === "function" && visible) {
    rafId = requestAnimationFrame(() => flushThreadEvents());
    timerId = setTimeout(() => flushThreadEvents(), BACKSTOP_MS);
  } else {
    timerId = setTimeout(() => flushThreadEvents(), FALLBACK_MS);
  }
}

/** Applies buffered events for one thread (or every thread) now, with a single store update. */
export function flushThreadEvents(threadId?: string): void {
  const batches = take(threadId);
  if (pending.size === 0) cancelScheduled();
  if (batches.length === 0) return;
  useThreadStore.setState((s) => {
    const threads = applyAll(s.threads, batches);
    return threads === s.threads ? s : { threads };
  });
  if (pending.size > 0) schedule();
}

/** Buffers a channel event for the next frame's flush (applies it at once when batching is off). */
export function queueThreadEvent(threadId: string, action: ThreadAction): void {
  if (!batching) {
    useThreadStore.getState().dispatch(threadId, action);
    return;
  }
  const now = Date.now();
  const list = pending.get(threadId);
  if (list) list.push({ action, now });
  else pending.set(threadId, [{ action, now }]);
  schedule();
}

// Waking from sleep (lid closed) may have lost the scheduled flush; apply whatever is buffered as
// soon as the window is back, rather than when the next event or local action happens to come.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const wake = () => {
    if (pending.size > 0 && !document.hidden) flushThreadEvents();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);
}

/** Turns per-frame batching on or off (tests). Turning it off applies anything buffered. */
export function setThreadEventBatching(on: boolean): void {
  batching = on;
  if (!on) flushThreadEvents();
}

/** Test-only: drops buffered events and any scheduled flush. */
export function __resetThreadEventsForTests(): void {
  pending.clear();
  cancelScheduled();
}

const EMPTY: ThreadRuntime = initialRuntime();

/** The thread's runtime (after its buffered events), or a shared empty runtime before any event arrived. */
export function getRuntime(threadId: string): ThreadRuntime {
  if (pending.has(threadId)) flushThreadEvents(threadId);
  return useThreadStore.getState().threads[threadId] ?? EMPTY;
}

/** React hook: the thread's runtime (stable empty runtime until the thread has state). */
export function useThreadRuntime(threadId: string): ThreadRuntime {
  return useThreadStore((s) => s.threads[threadId] ?? EMPTY);
}

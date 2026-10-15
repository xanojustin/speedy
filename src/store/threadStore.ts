// U8: per-thread chat runtime (status, transcript blocks, pending permissions, queue).
// Every thread's events are reduced here whether or not it is visible (KTD2); only rendering is
// limited to the selected thread. IO lives in `runtime.ts`; this module is state only.
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
  /** Applies one action to a thread's runtime (creating it on first use). */
  dispatch(threadId: string, action: ThreadAction): void;
}

export const useThreadStore = create<ThreadStoreState>((set) => ({
  threads: {},
  dispatch(threadId, action) {
    set((s) => ({
      threads: { ...s.threads, [threadId]: reduce(s.threads[threadId] ?? initialRuntime(), action, Date.now()) },
    }));
  },
}));

const EMPTY: ThreadRuntime = initialRuntime();

/** The thread's runtime, or a shared empty runtime before any event arrived. */
export function getRuntime(threadId: string): ThreadRuntime {
  return useThreadStore.getState().threads[threadId] ?? EMPTY;
}

/** React hook: the thread's runtime (stable empty runtime until the thread has state). */
export function useThreadRuntime(threadId: string): ThreadRuntime {
  return useThreadStore((s) => s.threads[threadId] ?? EMPTY);
}

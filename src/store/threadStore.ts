// U8: per-thread chat runtime (status, transcript blocks, pending permissions, queue).
// STUB: U8 replaces this with the real store, reducer, and the claude event bridge.
// Contract other units rely on: `useThreadStore(s => s.threads[threadId])` yields a
// ThreadRuntime with at least `status`, and every thread's events are ingested here
// whether or not it is visible (KTD2).
import { create } from "zustand";
import type { ThreadStatus } from "../ipc/types";

export interface ThreadRuntime {
  status: ThreadStatus;
}

export interface ThreadStoreState {
  threads: Record<string, ThreadRuntime>;
}

export const useThreadStore = create<ThreadStoreState>(() => ({ threads: {} }));

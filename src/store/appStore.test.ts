import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "./appStore";

const saves = () => invoke.mock.calls.filter((c) => c[0] === "state_save");
let threadId = "";

beforeEach(() => {
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: true });
  threadId = useAppStore.getState().addProject("/work/proj");
  useAppStore.getState().updateThread(threadId, { sessionId: "s1", title: "Work" });
  invoke.mockClear();
});

describe("updateThread", () => {
  it("does nothing (no new state, no state_save) when the patch changes no field", () => {
    const before = useAppStore.getState();
    const listener = vi.fn();
    const unsub = useAppStore.subscribe(listener);
    useAppStore.getState().updateThread(threadId, { sessionId: "s1" });
    useAppStore.getState().updateThread(threadId, { sessionId: "s1", title: "Work" });
    useAppStore.getState().updateThread(threadId, {});
    unsub();
    expect(listener).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
    expect(saves()).toHaveLength(0);
  });

  it("commits and saves when any field changes", () => {
    useAppStore.getState().updateThread(threadId, { sessionId: "s1", title: "Renamed" });
    expect(useAppStore.getState().projects[0].threads[0]).toMatchObject({ sessionId: "s1", title: "Renamed" });
    expect(saves()).toHaveLength(1);
  });
});

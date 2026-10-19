import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) =>
    // Host RPCs reach this fake by their method name.
    (cmd === "host_call" ? invoke((args as { method: string }).method, (args as { params: unknown }).params) : invoke(cmd, args)),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "./appStore";

const saves = () => invoke.mock.calls.filter((c) => c[0] === "client_state_save" || c[0] === "thread_update");
let threadId = "";

beforeEach(() => {
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: true });
  threadId = useAppStore.getState().addProject("/work/proj");
  useAppStore.getState().updateThread(threadId, { sessionId: "s1", title: "Work" });
  invoke.mockClear();
});

describe("updateThread", () => {
  it("does nothing (no new state, no save, no host call) when the patch changes no field", () => {
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

  it("sends a changed host field to the host and saves the client's half", () => {
    useAppStore.getState().updateThread(threadId, { sessionId: "s1", title: "Renamed" });
    expect(useAppStore.getState().projects[0].threads[0]).toMatchObject({ sessionId: "s1", title: "Renamed" });
    expect(invoke.mock.calls.filter((c) => c[0] === "thread_update").map((c) => c[1])).toEqual([{ threadId, patch: { title: "Renamed" } }]);
    expect(invoke.mock.calls.filter((c) => c[0] === "client_state_save")).toHaveLength(1);
  });

  it("keeps layout changes on the client", () => {
    useAppStore.getState().updateThread(threadId, { splitRatio: 0.4, terminalVisible: true });
    expect(invoke.mock.calls.filter((c) => c[0] === "thread_update")).toHaveLength(0);
    const saved = invoke.mock.calls.filter((c) => c[0] === "client_state_save").at(-1)?.[1] as { state: { threads: unknown[] } };
    expect(saved.state.threads).toEqual([{ threadId, splitRatio: 0.4, explorerVisible: false, terminalVisible: true, terminalMaximized: false }]);
  });
});

describe("load", () => {
  it("puts a group saved without its host back under the host of its projects", async () => {
    const projects = [
      { hostId: "mini", projectId: "p1", collapsed: false, groupId: "g-remote" },
      { hostId: "local", projectId: "p2", collapsed: false, groupId: "g-local" },
    ];
    const groups = [
      { id: "g-remote", name: "Remote", collapsed: false, color: "blue" },
      { id: "g-local", name: "Local", collapsed: false, color: "green" },
      { id: "g-empty", name: "Empty", collapsed: false, color: "red" },
    ];
    invoke.mockImplementation(async (cmd: unknown) => (cmd === "client_state_load" ? { state: { groups, projects, threads: [] }, notice: null } : undefined));
    await useAppStore.getState().load();
    invoke.mockImplementation(async () => undefined);
    expect(useAppStore.getState().groups.map((g) => [g.id, g.hostKey])).toEqual([
      ["g-remote", "mini"],
      ["g-local", undefined],
      ["g-empty", undefined],
    ]);
  });
});

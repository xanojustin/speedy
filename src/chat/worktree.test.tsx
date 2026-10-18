import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WT = "/data/worktrees/proj/feature-x";
let branchOf: Record<string, string | null> = {};
/** The host couldn't create the requested worktree, so its start fails. */
let failStart = false;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "explorer_git_branch":
      return branchOf[args!.root as string] ?? null;
    case "claude_start":
      if (failStart) throw "Couldn't create a worktree: could not lock config file";
      return "idle";
    default:
      return undefined;
  }
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) =>
    // Host RPCs reach this fake by their method name, like the old commands.
    (cmd === "host_call" ? invoke((args as { method: string }).method, (args as { params: Record<string, unknown> }).params) : invoke(cmd, args)),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { findThread, useAppStore } from "../store/appStore";
import { __resetRuntimeForTests, sendUserMessage } from "../store/runtime";
import { useThreadStore } from "../store/threadStore";
import { Composer } from "../composer/Composer";
import { ChatHeader } from "./ChatHeader";

let threadId = "";
const thread = () => findThread(useAppStore.getState(), threadId)!.thread;
const settle = () => act(async () => {});
const renderThread = () =>
  render(
    <>
      <ChatHeader threadId={threadId} />
      <Composer threadId={threadId} />
    </>,
  );
const worktreeToggle = () => screen.queryByRole("button", { name: "Worktree" });

beforeEach(() => {
  branchOf = { "/work/proj": "main", [WT]: "speedy/abc" };
  failStart = false;
  invoke.mockClear();
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  // This Mac is connected, as it is by the time a thread shows.
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false, hosts: [{ key: "local", state: { state: "connected", host_id: "this-mac", agent_version: "test" }, update: null }] });
  threadId = useAppStore.getState().addProject("/work/proj");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Branch and worktree", () => {
  it("follows checkouts in the project folder", async () => {
    vi.useFakeTimers();
    useAppStore.getState().updateThread(threadId, { sessionId: "s-1" });
    render(<ChatHeader threadId={threadId} />);
    await settle();
    expect(screen.getByTitle("Branch: main")).toHaveTextContent("main");

    branchOf["/work/proj"] = "justin/DEV-1/thing";
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByTitle("Branch: justin/DEV-1/thing")).toBeInTheDocument();
  });

  it("shows nothing outside a git repository", async () => {
    branchOf = {};
    render(<ChatHeader threadId={threadId} />);
    await settle();
    expect(screen.queryByTitle(/^Branch:/)).not.toBeInTheDocument();
  });

  it("asks the host for a worktree, then shows and locks the branch the host made", async () => {
    renderThread();
    await settle();
    fireEvent.click(worktreeToggle()!);
    expect(thread().worktreeRequested).toBe(true);
    expect(worktreeToggle()).toHaveAttribute("aria-pressed", "true");
    expect(invoke).toHaveBeenCalledWith("thread_update", { threadId, patch: { worktreeRequested: true } });

    await act(() => sendUserMessage(threadId, [{ type: "text", text: "hi" }]));
    // The host creates the worktree before its first start, then reports the thread.
    const hostThread = { ...thread(), worktree: { path: WT, branch: "speedy/abc" }, worktreeRequested: false, fork: null, queue: [] };
    act(() => useAppStore.getState().applyHostEvent("local", { kind: "thread_upserted", projectId: useAppStore.getState().projects[0].id, thread: hostThread }));
    await settle();

    expect(thread()).toMatchObject({ worktree: { path: WT }, worktreeRequested: false });
    expect(worktreeToggle()).not.toBeInTheDocument();
    expect(screen.getByTitle(/^Branch: speedy\/abc \(worktree at/)).toBeInTheDocument();
  });

  it("an unchecked thread asks for no worktree", async () => {
    await act(() => sendUserMessage(threadId, [{ type: "text", text: "hi" }]));
    expect(invoke).toHaveBeenCalledWith("claude_send_user", expect.objectContaining({ threadId }));
    expect(invoke).not.toHaveBeenCalledWith("thread_update", expect.objectContaining({ patch: { worktreeRequested: true } }));
  });

  it("keeps the choice open when the host can't create the worktree", async () => {
    failStart = true;
    useAppStore.getState().updateThread(threadId, { worktreeRequested: true });
    renderThread();
    await act(() => sendUserMessage(threadId, [{ type: "text", text: "hi" }]));
    await settle();
    expect(thread().worktree).toBeNull();
    fireEvent.click(worktreeToggle()!);
    expect(thread().worktreeRequested).toBe(false);
  });

  it("can't change branch once the conversation has started", async () => {
    useAppStore.getState().updateThread(threadId, { sessionId: "s-1" });
    renderThread();
    await settle();
    expect(screen.getByTitle("Branch: main")).toBeInTheDocument();
    expect(worktreeToggle()).not.toBeInTheDocument();
  });
});

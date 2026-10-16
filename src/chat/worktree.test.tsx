import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WT = "/data/worktrees/proj/feature-x";
let branchOf: Record<string, string | null> = {};
let failCreate = false;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "explorer_git_branch":
      return branchOf[args!.root as string] ?? null;
    case "worktree_create":
      if (failCreate) throw "could not lock config file";
      return { path: WT, branch: args!.branch };
    case "claude_start":
      return "idle";
    default:
      return undefined;
  }
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => invoke(cmd, args),
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
  failCreate = false;
  invoke.mockClear();
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false });
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

  it("starts a checked thread on a new branch in its own worktree, then locks it", async () => {
    renderThread();
    await settle();
    fireEvent.click(worktreeToggle()!);
    expect(thread().worktreeRequested).toBe(true);
    expect(worktreeToggle()).toHaveAttribute("aria-pressed", "true");
    expect(invoke).not.toHaveBeenCalledWith("worktree_create", expect.anything());

    await act(() => sendUserMessage(threadId, [{ type: "text", text: "hi" }]));
    await settle();

    expect(invoke).toHaveBeenCalledWith("worktree_create", { root: "/work/proj", branch: `speedy/${threadId.slice(0, 8)}` });
    expect(invoke).toHaveBeenCalledWith("claude_start", expect.objectContaining({ options: expect.objectContaining({ cwd: WT }) }));
    expect(thread()).toMatchObject({ worktree: { path: WT }, worktreeRequested: false });
    expect(worktreeToggle()).not.toBeInTheDocument();
    expect(screen.getByTitle(/^Branch: speedy\/abc \(worktree at/)).toBeInTheDocument();
  });

  it("an unchecked thread starts in the project folder", async () => {
    await act(() => sendUserMessage(threadId, [{ type: "text", text: "hi" }]));
    expect(invoke).not.toHaveBeenCalledWith("worktree_create", expect.anything());
    expect(invoke).toHaveBeenCalledWith("claude_start", expect.objectContaining({ options: expect.objectContaining({ cwd: "/work/proj" }) }));
  });

  it("keeps the choice open when the worktree can't be created", async () => {
    failCreate = true;
    useAppStore.getState().updateThread(threadId, { worktreeRequested: true });
    renderThread();
    await act(() => sendUserMessage(threadId, [{ type: "text", text: "hi" }]));
    await settle();
    expect(invoke).not.toHaveBeenCalledWith("claude_start", expect.anything());
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

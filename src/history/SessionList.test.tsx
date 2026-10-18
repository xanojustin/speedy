import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) =>
    // Host RPCs reach this fake by their method name.
    (cmd === "host_call" ? invoke((args as { method: string }).method, (args as { params: unknown }).params) : invoke(cmd, args)),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
const ask = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...a: unknown[]) => ask(...a) }));

import { ChatHeader } from "../chat/ChatHeader";
import { findThread, useAppStore } from "../store/appStore";
import { __resetRuntimeForTests } from "../store/runtime";
import { useThreadStore } from "../store/threadStore";
import { SessionList } from "./SessionList";

const NOW = Date.now();
const MIN = 60_000;
const meta = (sessionId: string, title: string, ageMs: number): SessionMeta => ({
  sessionId,
  title,
  createdMs: NOW - ageMs - MIN,
  modifiedMs: NOW - ageMs,
  filePath: `/home/.claude/projects/-work-proj/${sessionId}.jsonl`,
});
let sessions: SessionMeta[] = [];
const transcript = [
  { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "fix the bug" }, timestamp: "2026-10-14T10:00:00Z" },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Fixed it." }] },
    timestamp: "2026-10-14T10:00:05Z",
  },
];

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
let projectId = "";
let firstThreadId = "";

beforeEach(() => {
  sessions = [meta("s-old", "Refactor the parser", 3 * 24 * 60 * MIN), meta("s-new", "Fix login bug", 5 * MIN)];
  invoke.mockReset();
  ask.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "sessions_list":
        return sessions;
      case "session_load":
        return transcript;
      case "claude_start":
        return "idle";
      case "session_rename_offline":
        sessions = sessions.map((s) => (s.sessionId === args.sessionId ? { ...s, title: String(args.title) } : s));
        return undefined;
      default:
        return undefined;
    }
  });
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  // This Mac is connected, as it is by the time a thread shows.
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false, hosts: [{ key: "local", state: { state: "connected", host_id: "this-mac", agent_version: "test" }, update: null }] });
  firstThreadId = useAppStore.getState().addProject("/work/proj");
  projectId = useAppStore.getState().projects[0].id;
});
afterEach(cleanup);

const threads = () => useAppStore.getState().projects[0].threads;
const row = (title: string) => screen.getByRole("button", { name: new RegExp(title) });

async function open(onClose = vi.fn()) {
  render(<SessionList projectId={projectId} onClose={onClose} />);
  await screen.findByText("Fix login bug");
  return onClose;
}

describe("SessionList", () => {
  it("lists the project's CLI sessions with title and relative time, and search filters them", async () => {
    await open();
    expect(calls("sessions_list")[0][1]).toEqual({ projectPath: "/work/proj" });
    expect(within(row("Fix login bug")).getByText("5m")).toBeInTheDocument();
    expect(within(row("Refactor the parser")).getByText("3d")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions…"), { target: { value: "PARSER" } });
    expect(screen.queryByText("Fix login bug")).not.toBeInTheDocument();
    expect(screen.getByText("Refactor the parser")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions…"), { target: { value: "nothing like it" } });
    expect(screen.getByText("No matching conversations")).toBeInTheDocument();
  });

  it("shows an empty state for a project with no sessions", async () => {
    sessions = [];
    render(<SessionList projectId={projectId} onClose={vi.fn()} />);
    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
  });

  it("resuming creates and selects a thread bound to the session, seeds it from the JSONL, and starts it with --resume", async () => {
    const onClose = await open();
    fireEvent.click(row("Fix login bug"));
    await waitFor(() => expect(calls("claude_start")).toHaveLength(1));

    const created = threads().find((t) => t.sessionId === "s-new")!;
    expect(created).toBeDefined();
    expect(created.title).toBe("Fix login bug");
    expect(useAppStore.getState().selectedThreadId).toBe(created.id);
    expect(calls("session_load")[0][1]).toEqual({ projectPath: "/work/proj", sessionId: "s-new" });
    // The host resumes the bound session in the project folder.
    expect(calls("thread_create").at(-1)?.[1]).toMatchObject({ thread: { id: created.id, sessionId: "s-new" } });
    expect(calls("claude_start")[0][1]).toEqual({ threadId: created.id });
    const blocks = useThreadStore.getState().threads[created.id].blocks;
    expect(blocks.map((b) => b.kind)).toEqual(["user", "text"]);
    expect(onClose).toHaveBeenCalled();
    // The thread that was open before is untouched.
    expect(findThread(useAppStore.getState(), firstThreadId)?.thread.sessionId).toBeNull();
  });

  it("resuming a session already bound to an open thread selects it without a second process", async () => {
    const bound = useAppStore.getState().createThread(projectId, { sessionId: "s-new", title: "Fix login bug" });
    useAppStore.getState().selectThread(firstThreadId);
    await open();
    fireEvent.click(row("Fix login bug"));
    await waitFor(() => expect(useAppStore.getState().selectedThreadId).toBe(bound));
    expect(threads()).toHaveLength(2);
    expect(calls("claude_start")).toHaveLength(0);
    expect(calls("session_load")).toHaveLength(0);
  });

  it("resuming a session bound to an archived thread restores and selects it", async () => {
    const bound = useAppStore.getState().createThread(projectId, { sessionId: "s-old", title: "Refactor the parser" });
    useAppStore.getState().archiveThread(bound);
    await open();
    fireEvent.click(row("Refactor the parser"));
    await waitFor(() => expect(useAppStore.getState().selectedThreadId).toBe(bound));
    expect(findThread(useAppStore.getState(), bound)?.thread.archived).toBe(false);
    expect(threads()).toHaveLength(2);
    expect(calls("claude_start")).toHaveLength(0);
  });

  it("asks before resuming a session modified 30 s ago; declining creates nothing", async () => {
    sessions = [meta("s-live", "Live in VS Code", 30_000)];
    ask.mockResolvedValue(false);
    render(<SessionList projectId={projectId} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Live in VS Code/ }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(String(ask.mock.calls[0][0])).toMatch(/two/i);
    await act(async () => {});
    expect(threads()).toHaveLength(1);
    expect(calls("claude_start")).toHaveLength(0);
    expect(calls("session_load")).toHaveLength(0);
  });

  it("resumes a recently modified session once the user accepts the warning", async () => {
    sessions = [meta("s-live", "Live in VS Code", 30_000)];
    ask.mockResolvedValue(true);
    render(<SessionList projectId={projectId} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Live in VS Code/ }));
    await waitFor(() => expect(calls("claude_start")).toHaveLength(1));
    expect(threads().some((t) => t.sessionId === "s-live")).toBe(true);
  });

  it("a session whose file is gone shows the error and creates no thread", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sessions_list") return sessions;
      if (cmd === "session_load") throw "session s-new not found at /home/.claude/projects/-work-proj/s-new.jsonl";
      return undefined;
    });
    const onClose = await open();
    fireEvent.click(row("Fix login bug"));
    expect(await screen.findByRole("alert")).toHaveTextContent("s-new not found");
    expect(threads()).toHaveLength(1);
    expect(calls("claude_start")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the error when the session list can't be read", async () => {
    invoke.mockImplementation(async () => {
      throw "permission denied";
    });
    render(<SessionList projectId={projectId} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });

  it("renaming with no live actor appends a custom title offline and the list shows it", async () => {
    const bound = useAppStore.getState().createThread(projectId, { sessionId: "s-old", title: "Refactor the parser" });
    await open();
    fireEvent.click(within(row("Refactor the parser").parentElement!).getByRole("button", { name: "Rename session" }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    fireEvent.change(input, { target: { value: "Parser rewrite" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Parser rewrite")).toBeInTheDocument();
    expect(calls("session_rename_offline")[0][1]).toEqual({ projectPath: "/work/proj", sessionId: "s-old", title: "Parser rewrite" });
    expect(calls("claude_control")).toHaveLength(0);
    expect(findThread(useAppStore.getState(), bound)?.thread.title).toBe("Parser rewrite");
  });

  it("renaming a session with a live actor sends rename_session to it", async () => {
    const bound = useAppStore.getState().createThread(projectId, { sessionId: "s-new", title: "Fix login bug" });
    useThreadStore.getState().dispatch(bound, { kind: "local_status", status: "idle" });
    await open();
    fireEvent.click(within(row("Fix login bug").parentElement!).getByRole("button", { name: "Rename session" }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    fireEvent.change(input, { target: { value: "Login fix" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Login fix")).toBeInTheDocument();
    expect(calls("claude_control")[0][1]).toMatchObject({ threadId: bound, request: { subtype: "rename_session", title: "Login fix" } });
    expect(calls("session_rename_offline")).toHaveLength(0);
    expect(findThread(useAppStore.getState(), bound)?.thread.title).toBe("Login fix");
  });

  it("Escape cancels an inline rename without writing", async () => {
    await open();
    fireEvent.click(within(row("Fix login bug").parentElement!).getByRole("button", { name: "Rename session" }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
    expect(calls("session_rename_offline")).toHaveLength(0);
  });
});

describe("New conversation (chat header)", () => {
  it("creates a new thread and keeps the previous one intact", () => {
    useAppStore.getState().updateThread(firstThreadId, { sessionId: "s-new", title: "Fix login bug" });
    render(<ChatHeader threadId={firstThreadId} />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(threads()).toHaveLength(2);
    expect(findThread(useAppStore.getState(), firstThreadId)?.thread).toMatchObject({ sessionId: "s-new", archived: false });
    expect(useAppStore.getState().selectedThreadId).not.toBe(firstThreadId);
  });
});

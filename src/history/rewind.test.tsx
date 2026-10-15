import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => invoke(cmd, args),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { BlockView } from "../chat/messages/BlockView";
import { findThread, useAppStore } from "../store/appStore";
import { __resetRuntimeForTests, seedTranscript } from "../store/runtime";
import { useThreadStore, type ViewBlock } from "../store/threadStore";
import { forkPoint } from "./rewind";

const user = (uuid: string, parentUuid: string | null, text: string) => ({
  type: "user",
  uuid,
  parentUuid,
  message: { role: "user", content: text },
});
const assistant = (uuid: string, parentUuid: string, id: string, text: string) => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: { id, role: "assistant", content: [{ type: "text", text }] },
});
// u2's parent is a system line, so the fork point is found by walking the parentUuid chain.
const lines = [
  user("u1", null, "add a parser"),
  assistant("a1", "u1", "msg_1", "Added src/parser.ts."),
  { type: "system", subtype: "stop_hook_summary", uuid: "sys1", parentUuid: "a1" },
  user("u2", "sys1", "now refactor it"),
  assistant("a2", "u2", "msg_2", "Refactored."),
];

const preview = { canRewind: true, filesChanged: ["/work/proj/src/parser.ts", "/work/proj/src/lexer.ts"], insertions: 3, deletions: 5 };
const NO_POS = { prev: false, next: false };
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const controls = () => calls("claude_control").map((c) => (c[1] as { request: Record<string, unknown> }).request);
let threadId = "";
let rewindResponse: Record<string, unknown> = preview;

beforeEach(() => {
  rewindResponse = preview;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "claude_start":
        return "idle";
      case "session_load":
        return lines;
      case "claude_control":
        return rewindResponse;
      default:
        return undefined;
    }
  });
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false });
  threadId = useAppStore.getState().addProject("/work/proj");
  useAppStore.getState().updateThread(threadId, { sessionId: "s1", title: "Parser work" });
  seedTranscript(threadId, lines);
});
afterEach(cleanup);

const blocksOf = (id: string) => useThreadStore.getState().threads[id]?.blocks ?? [];
const userBlock = (uuid: string) => blocksOf(threadId).find((b) => b.kind === "user" && b.uuid === uuid) as ViewBlock;
const threads = () => useAppStore.getState().projects[0].threads;
const forkStarts = () => calls("claude_start").filter((c) => (c[1] as { threadId: string }).threadId !== threadId);

function openAction(uuid: string, option: string) {
  render(<BlockView block={userBlock(uuid)} pos={NO_POS} stamp={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: option }));
}

describe("rewind", () => {
  it("fork and rewind: previews the files, then restores them and continues in a fork from the previous message", async () => {
    openAction("u2", "Fork conversation and rewind code");
    expect(await screen.findByText("src/parser.ts")).toBeInTheDocument();
    expect(screen.getByText("src/lexer.ts")).toBeInTheDocument();
    expect(screen.getByText(/5 lines/)).toBeInTheDocument();
    expect(screen.getByText(/3 lines/)).toBeInTheDocument();
    expect(controls()).toEqual([{ subtype: "rewind_files", user_message_id: "u2", dry_run: true }]);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(forkStarts()).toHaveLength(1));
    expect(controls()).toEqual([
      { subtype: "rewind_files", user_message_id: "u2", dry_run: true },
      { subtype: "rewind_files", user_message_id: "u2", dry_run: false },
    ]);

    const fork = threads().find((t) => t.id !== threadId)!;
    expect(forkStarts()[0][1]).toMatchObject({
      threadId: fork.id,
      options: { cwd: "/work/proj", resumeSessionId: "s1", resumeSessionAt: "a1", forkSession: true },
    });
    expect(useAppStore.getState().selectedThreadId).toBe(fork.id);
    // The fork shows the conversation up to the rewound message; the original thread is untouched.
    expect(blocksOf(fork.id).map((b) => (b.kind === "user" || b.kind === "text" ? b.text : b.kind))).toEqual([
      "add a parser",
      "Added src/parser.ts.",
    ]);
    expect(blocksOf(threadId)).toHaveLength(4);
    expect(findThread(useAppStore.getState(), threadId)?.thread.sessionId).toBe("s1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancelling at the file review sends nothing more", async () => {
    openAction("u2", "Fork conversation and rewind code");
    await screen.findByText("src/parser.ts");
    fireEvent.click(screen.getByRole("button", { name: "Never mind" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(controls()).toHaveLength(1);
    expect(forkStarts()).toHaveLength(0);
    expect(threads()).toHaveLength(1);
  });

  it("rewind code only restores the files and keeps the conversation", async () => {
    openAction("u2", "Rewind code to here");
    await screen.findByText("src/parser.ts");
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(controls()).toHaveLength(2));
    expect(controls()[1]).toEqual({ subtype: "rewind_files", user_message_id: "u2", dry_run: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(forkStarts()).toHaveLength(0);
    expect(threads()).toHaveLength(1);
  });

  it("shows why code can't be rewound and disables confirming", async () => {
    rewindResponse = { canRewind: false, error: "No file checkpoint found for this message" };
    openAction("u2", "Rewind code to here");
    expect(await screen.findByText(/No file checkpoint found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rewind" })).toBeDisabled();
  });

  it("fork conversation from here forks without touching files", async () => {
    openAction("u2", "Fork conversation from here");
    await waitFor(() => expect(forkStarts()).toHaveLength(1));
    expect(controls()).toHaveLength(0);
    expect(forkStarts()[0][1]).toMatchObject({ options: { resumeSessionId: "s1", resumeSessionAt: "a1", forkSession: true } });
  });

  it("forking from the first message starts a fresh conversation", async () => {
    openAction("u1", "Fork conversation from here");
    await waitFor(() => expect(threads()).toHaveLength(2));
    const fresh = threads().find((t) => t.id !== threadId)!;
    expect(fresh.sessionId).toBeNull();
    expect(useAppStore.getState().selectedThreadId).toBe(fresh.id);
    expect(forkStarts()).toHaveLength(0);
  });

  it("offers no rewind on a user message the CLI hasn't assigned a uuid yet", () => {
    render(<BlockView block={{ kind: "user", id: "local-1", uuid: null, text: "pending", images: 0, ts: null }} pos={NO_POS} stamp={null} />);
    expect(screen.queryByRole("button", { name: "Message actions" })).not.toBeInTheDocument();
  });
});

describe("forkPoint", () => {
  it("keeps the active chain up to the message before the rewound one", () => {
    const branched = [...lines, user("u3", "a1", "a later branch"), assistant("a3", "u3", "msg_3", "Branch reply.")];
    const { anchor, history } = forkPoint(branched, "u3");
    expect(anchor).toBe("a1");
    expect(history.map((l) => l.uuid)).toEqual(["u1", "a1"]);
  });

  it("has no anchor for the first message", () => {
    expect(forkPoint(lines, "u1")).toEqual({ anchor: null, history: [] });
  });

  it("rejects a message that isn't in the session", () => {
    expect(() => forkPoint(lines, "nope")).toThrow(/not found/);
  });
});

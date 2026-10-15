import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent, ThreadStatus } from "../ipc/types";

const invoke = vi.fn();
let channel: { onmessage: (e: ClaudeEvent) => void } | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "claude_start") channel = args.onEvent as typeof channel;
    return invoke(cmd, args);
  },
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "./appStore";
import { flushThreadEvents, setThreadEventBatching, useThreadStore } from "./threadStore";
import {
  ensureStarted,
  interruptThread,
  removeQueued,
  respondPermission,
  retryThread,
  sendUserMessage,
  __resetRuntimeForTests,
} from "./runtime";

const emit = (e: ClaudeEvent) => channel!.onmessage(e);
const status = (s: ThreadStatus, seq = 1): ClaudeEvent => ({
  kind: "status",
  seq,
  status: s,
  detail: null,
  stderr_tail: null,
  reconnecting: false,
});
const rt = (id: string) => useThreadStore.getState().threads[id];
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const flush = () => new Promise((r) => setTimeout(r, 0));

let threadId = "";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "claude_start" ? "starting" : undefined));
  channel = null;
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false });
  threadId = useAppStore.getState().addProject("/work/proj");
  useAppStore.getState().updateThread(threadId, { sessionId: "old-session", model: "opus", permissionMode: "plan" });
});

describe("runtime bridge", () => {
  it("starts lazily once with the project's cwd, resume id, model, and mode", async () => {
    await Promise.all([ensureStarted(threadId), ensureStarted(threadId)]);
    expect(calls("claude_start")).toHaveLength(1);
    expect(calls("claude_start")[0][1]).toMatchObject({
      threadId,
      options: { cwd: "/work/proj", resumeSessionId: "old-session", model: "opus", permissionMode: "plan" },
    });
    expect(rt(threadId).status).toBe("starting");
  });

  it("queues while not idle, sends on idle, and sends the next queued message when a result arrives", async () => {
    await sendUserMessage(threadId, [{ type: "text", text: "first" }]);
    expect(calls("claude_send_user")).toHaveLength(0);
    expect(rt(threadId).queue).toHaveLength(1);

    emit(status("idle"));
    await flush();
    expect(calls("claude_send_user").map((c) => c[1].content)).toEqual([[{ type: "text", text: "first" }]]);
    expect(rt(threadId).queue).toHaveLength(0);
    expect(rt(threadId).blocks.filter((b) => b.kind === "user")).toHaveLength(1);

    emit(status("working", 2));
    await sendUserMessage(threadId, [{ type: "text", text: "second" }]);
    await sendUserMessage(threadId, [{ type: "text", text: "third" }]);
    expect(calls("claude_send_user")).toHaveLength(1);
    expect(rt(threadId).queue.map((q) => q.content)).toEqual([[{ type: "text", text: "second" }], [{ type: "text", text: "third" }]]);

    emit({ kind: "message", seq: 3, raw: { type: "result", subtype: "success", is_error: false } });
    emit(status("idle", 4)); // the actor's own idle after the result must not double-send
    await flush();
    expect(calls("claude_send_user").map((c) => c[1].content)).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
    ]);
    expect(rt(threadId).queue).toHaveLength(1);

    removeQueued(threadId, rt(threadId).queue[0].id);
    expect(rt(threadId).queue).toHaveLength(0);
  });

  it("titles a new thread from its first message and persists session_bound", async () => {
    await sendUserMessage(threadId, [{ type: "text", text: "  Refactor   the parser so that it handles nested blocks and also reports errors nicely  " }]);
    const title = useAppStore.getState().projects[0].threads[0].title;
    expect(title.startsWith("Refactor the parser so that it handles")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61);

    emit({ kind: "session_bound", seq: 5, session_id: "new-session" });
    expect(useAppStore.getState().projects[0].threads[0].sessionId).toBe("new-session");
    expect(rt(threadId).sessionId).toBe("new-session");
  });

  it("removes a pending permission when sent, and swaps in the refreshed diff when stale", async () => {
    await ensureStarted(threadId);
    const req = { subtype: "can_use_tool" as const, tool_name: "Edit", input: {} };
    emit({ kind: "permission_request", seq: 2, request_id: "r1", request: req, diff: [{ path: "a", isNewFile: false, unified: "old", baseFingerprint: "1" }] });
    emit({ kind: "permission_request", seq: 3, request_id: "r2", request: req, diff: null });

    invoke.mockResolvedValueOnce({ sent: false, refreshedDiff: [{ path: "a", isNewFile: false, unified: "new", baseFingerprint: "2" }] });
    const stale = await respondPermission(threadId, "r1", { behavior: "allow", updatedInput: {} });
    expect(stale.sent).toBe(false);
    expect(rt(threadId).pendingPermissions.find((p) => p.requestId === "r1")?.diff?.[0].unified).toBe("new");

    invoke.mockResolvedValueOnce({ sent: true, refreshedDiff: null });
    await respondPermission(threadId, "r2", { behavior: "deny", message: "no" });
    expect(rt(threadId).pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    expect(calls("claude_respond_permission").at(-1)?.[1]).toEqual({ threadId, requestId: "r2", response: { behavior: "deny", message: "no" } });
  });

  it("interrupts and retries through the IPC commands", async () => {
    await ensureStarted(threadId);
    emit({ kind: "status", seq: 2, status: "crashed", detail: "exited 1", stderr_tail: "boom", reconnecting: false });
    await interruptThread(threadId);
    expect(calls("claude_interrupt")).toHaveLength(1);
    invoke.mockResolvedValueOnce("starting");
    await retryThread(threadId);
    expect(calls("claude_retry")).toHaveLength(1);
    expect(rt(threadId)).toMatchObject({ status: "starting", retrying: true });
  });

  it("ingests events for threads that are not selected", async () => {
    await ensureStarted(threadId);
    useAppStore.getState().selectThread(null);
    emit({ kind: "message", seq: 2, raw: { type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: "bg" }] } } });
    expect(rt(threadId).blocks).toHaveLength(1);
  });

  it("restarts a stopped thread on the next send and delivers the message queued while stopped", async () => {
    await ensureStarted(threadId);
    emit(status("idle", 1));
    emit(status("stopped", 2)); // archived: claude_stop moved the actor to Stopped
    await flush();
    expect(rt(threadId).status).toBe("stopped");

    await sendUserMessage(threadId, [{ type: "text", text: "after restore" }]);
    expect(calls("claude_start")).toHaveLength(2);
    expect(calls("claude_start")[1][1]).toMatchObject({ threadId, options: { resumeSessionId: "old-session" } });
    expect(calls("claude_send_user")).toHaveLength(0);
    expect(rt(threadId).queue).toHaveLength(1);

    emit(status("idle", 3));
    await flush();
    expect(calls("claude_send_user").map((c) => c[1].content)).toEqual([[{ type: "text", text: "after restore" }]]);
    expect(rt(threadId).queue).toHaveLength(0);
  });
});

describe("runtime bridge with per-frame batching", () => {
  beforeEach(() => setThreadEventBatching(true));
  afterEach(() => setThreadEventBatching(false));

  it("buffers channel events until the frame, but decisions read the applied state", async () => {
    await sendUserMessage(threadId, [{ type: "text", text: "first" }]);
    expect(rt(threadId).queue).toHaveLength(1);

    const before = useThreadStore.getState();
    emit({ kind: "message", seq: 2, raw: { type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: "bg" }] } } });
    // Not applied yet: subscribers are not notified per channel event.
    expect(useThreadStore.getState()).toBe(before);

    // The idle status sends the queued message, which lands after the buffered events.
    emit(status("idle", 3));
    await flush();
    expect(calls("claude_send_user").map((c) => c[1].content)).toEqual([[{ type: "text", text: "first" }]]);
    expect(rt(threadId).blocks.map((b) => b.kind)).toEqual(["text", "user"]);
    expect(rt(threadId).status).toBe("working");

    emit({ kind: "session_bound", seq: 4, session_id: "new-session" });
    expect(useAppStore.getState().projects[0].threads[0].sessionId).toBe("new-session");
    flushThreadEvents();
    expect(rt(threadId).sessionId).toBe("new-session");
  });
});

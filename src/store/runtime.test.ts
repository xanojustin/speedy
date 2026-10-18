import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent, ThreadSnapshot, ThreadStatus } from "../ipc/types";

const invoke = vi.fn();
let channel: { onmessage: (e: ClaudeEvent) => void } | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "host_thread_subscribe") channel = args.onEvent as typeof channel;
    // Host RPCs reach this fake by their method name.
    if (cmd === "host_call") return invoke(args.method, args.params);
    return invoke(cmd, args);
  },
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "./appStore";
import { flushThreadEvents, setThreadEventBatching, useThreadStore } from "./threadStore";
import { ensureStarted, interruptThread, removeQueued, respondPermission, retryThread, sendUserMessage, __resetRuntimeForTests } from "./runtime";

const emit = (e: ClaudeEvent) => channel!.onmessage(e);
const status = (s: ThreadStatus, seq = 1): ClaudeEvent => ({ kind: "status", seq, status: s, detail: null, stderr_tail: null, reconnecting: false });
const rt = (id: string) => useThreadStore.getState().threads[id];
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (t: string) => [{ type: "text", text: t }];

let threadId = "";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "claude_start" ? "starting" : undefined));
  channel = null;
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false });
  threadId = useAppStore.getState().addProject("/work/proj");
});

describe("runtime bridge", () => {
  it("subscribes and starts once; the host picks the thread's cwd, session, model and mode", async () => {
    await Promise.all([ensureStarted(threadId), ensureStarted(threadId)]);
    expect(calls("host_thread_subscribe")).toHaveLength(1);
    expect(calls("claude_start")).toHaveLength(1);
    expect(calls("claude_start")[0][1]).toEqual({ threadId });
    expect(rt(threadId).status).toBe("starting");
  });

  it("sends every message to the host, which echoes it and owns the queue", async () => {
    await sendUserMessage(threadId, text("first"));
    await sendUserMessage(threadId, text("second"));
    expect(calls("claude_send_user").map((c) => c[1].content)).toEqual([text("first"), text("second")]);
    // Nothing is shown or queued until the host says so.
    expect(rt(threadId)?.blocks ?? []).toHaveLength(0);

    emit(status("idle", 1));
    emit({ kind: "user_sent", seq: 2, id: "m1", content: text("first") });
    emit({ kind: "queue_changed", seq: 3, queue: [{ id: "q1", content: text("second") }] });
    expect(rt(threadId).blocks.filter((b) => b.kind === "user")).toHaveLength(1);
    expect(rt(threadId).status).toBe("working");
    expect(rt(threadId).queue.map((q) => q.content)).toEqual([text("second")]);

    removeQueued(threadId, "q1");
    await flush();
    expect(calls("queue_remove").at(-1)?.[1]).toEqual({ threadId, id: "q1" });
  });

  it("shows a message another client sent, and a failed send as a notice", async () => {
    await ensureStarted(threadId);
    emit(status("idle", 1));
    emit({ kind: "user_sent", seq: 2, id: "other", content: text("from the laptop") });
    expect(rt(threadId).blocks.at(-1)).toMatchObject({ kind: "user", text: "from the laptop" });
    emit({ kind: "send_failed", seq: 3, id: "other", error: "claude isn't running" });
    expect(rt(threadId).status).toBe("idle");
    expect(rt(threadId).blocks.at(-1)).toMatchObject({ kind: "notice", text: "Message not sent: claude isn't running" });
  });

  it("catches up from a snapshot: pending prompts, status and queue", async () => {
    await ensureStarted(threadId);
    const snapshot: ThreadSnapshot = {
      epoch: 9,
      seq: 40,
      sessionId: null,
      queue: [{ id: "q1", content: text("later") }],
      events: [
        { kind: "permission_request", seq: 30, request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} }, diff: null },
        status("awaiting_user", 31),
      ],
    };
    emit({ kind: "snapshot", snapshot });
    await flush();
    expect(rt(threadId).status).toBe("awaiting_user");
    expect(rt(threadId).pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    expect(rt(threadId).queue).toHaveLength(1);
  });

  it("drops a prompt another client answered", async () => {
    await ensureStarted(threadId);
    emit({ kind: "permission_request", seq: 2, request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} }, diff: null });
    emit({ kind: "permission_resolved", seq: 3, request_id: "r1", reason: "allowed" });
    expect(rt(threadId).pendingPermissions).toEqual([]);
  });

  it("removes a pending permission when sent, and swaps in the refreshed diff from its event when stale", async () => {
    await ensureStarted(threadId);
    const req = { subtype: "can_use_tool" as const, tool_name: "Edit", input: {} };
    emit({ kind: "permission_request", seq: 2, request_id: "r1", request: req, diff: [{ path: "a", isNewFile: false, unified: "old", baseFingerprint: "1" }] });
    emit({ kind: "permission_request", seq: 3, request_id: "r2", request: req, diff: null });

    invoke.mockResolvedValueOnce({ sent: false, refreshedDiff: [{ path: "a", isNewFile: false, unified: "new", baseFingerprint: "2" }] });
    const stale = await respondPermission(threadId, "r1", { behavior: "allow", updatedInput: {} });
    expect(stale.sent).toBe(false);
    emit({ kind: "diff_refreshed", seq: 4, request_id: "r1", diff: [{ path: "a", isNewFile: false, unified: "new", baseFingerprint: "2" }] });
    expect(rt(threadId).pendingPermissions.find((p) => p.requestId === "r1")?.diff?.[0].unified).toBe("new");

    invoke.mockResolvedValueOnce({ sent: true, refreshedDiff: null });
    await respondPermission(threadId, "r2", { behavior: "deny", message: "no" });
    expect(rt(threadId).pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    expect(calls("claude_respond_permission").at(-1)?.[1]).toEqual({ threadId, requestId: "r2", response: { behavior: "deny", message: "no" } });
  });

  it("interrupts and retries through the host", async () => {
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
});

describe("runtime bridge with per-frame batching", () => {
  beforeEach(() => setThreadEventBatching(true));
  afterEach(() => setThreadEventBatching(false));

  it("buffers host events until the frame", async () => {
    await ensureStarted(threadId);
    const before = useThreadStore.getState();
    emit({ kind: "message", seq: 2, raw: { type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: "bg" }] } } });
    // Not applied yet: subscribers are not notified per event.
    expect(useThreadStore.getState()).toBe(before);
    flushThreadEvents();
    expect(rt(threadId).blocks.map((b) => b.kind)).toEqual(["text"]);
  });
});

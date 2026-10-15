import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent, RawMessage } from "../ipc/types";
import { initialRuntime, reduce, type ThreadAction, type ThreadRuntime } from "./reducer";
import {
  __resetThreadEventsForTests,
  flushThreadEvents,
  getRuntime,
  queueThreadEvent,
  setThreadEventBatching,
  useThreadStore,
} from "./threadStore";
import { syntheticSession } from "../test/fixtures/synthetic";

let seq = 0;
const m = (raw: RawMessage): ClaudeEvent => ({ kind: "message", seq: ++seq, raw });
const se = (event: Record<string, unknown>, msgId = "msg_1"): ClaudeEvent =>
  m({ type: "stream_event", event, parent_tool_use_id: null, api_message_id: msgId });
const streamText = (...parts: string[]): ClaudeEvent[] => [
  se({ type: "message_start", message: { id: "msg_1", content: [] } }),
  se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
  se({ type: "content_block_stop", index: 0 }),
  se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  ...parts.map((text) => se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })),
];

let clock = 0;
const fold = (actions: ThreadAction[], from: ThreadRuntime = initialRuntime(), start = 1) =>
  actions.reduce((s, a, i) => reduce(s, a, start + i), from);

beforeEach(() => {
  __resetThreadEventsForTests();
  useThreadStore.setState({ threads: {} });
  clock = 0;
  vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  setThreadEventBatching(true);
});
afterEach(() => {
  setThreadEventBatching(false);
  __resetThreadEventsForTests();
  vi.restoreAllMocks();
});

describe("thread event batching", () => {
  it("buffers channel events and applies them with one store update, equal to applying them one by one", () => {
    const events = streamText("Hel", "lo ", "world");
    const listener = vi.fn();
    const unsub = useThreadStore.subscribe(listener);
    for (const e of events) queueThreadEvent("t1", e);
    expect(useThreadStore.getState().threads.t1).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    flushThreadEvents();
    unsub();
    expect(listener).toHaveBeenCalledTimes(1);
    // Each event keeps its own arrival time (Date.now() at queue time: 1, 2, 3, ...).
    expect(useThreadStore.getState().threads.t1).toEqual(fold(events));
    expect(useThreadStore.getState().threads.t1.blocks.map((b) => [b.kind, "text" in b ? b.text : ""])).toEqual([
      ["thinking", "hmm"],
      ["text", "Hello world"],
    ]);
  });

  it("matches one-by-one reduction on a long synthetic session", () => {
    const actions = syntheticSession(700);
    for (const a of actions) queueThreadEvent("t1", a);
    flushThreadEvents();
    expect(useThreadStore.getState().threads.t1).toEqual(fold(actions));
  });

  it("flushes every thread in a single update", () => {
    const listener = vi.fn();
    const unsub = useThreadStore.subscribe(listener);
    queueThreadEvent("a", { kind: "session_bound", seq: 1, session_id: "sa" });
    queueThreadEvent("b", { kind: "session_bound", seq: 1, session_id: "sb" });
    flushThreadEvents();
    unsub();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(useThreadStore.getState().threads.a.sessionId).toBe("sa");
    expect(useThreadStore.getState().threads.b.sessionId).toBe("sb");
  });

  it("applies a thread's buffered events before a local dispatch, preserving order", () => {
    queueThreadEvent("t1", { kind: "status", seq: 1, status: "idle", detail: null, stderr_tail: null, reconnecting: false });
    useThreadStore.getState().dispatch("t1", { kind: "local_user", id: "u1", content: [{ type: "text", text: "hi" }], ts: 5 });
    const rt = useThreadStore.getState().threads.t1;
    // idle (from the buffered status) then local_user -> working; the reverse order would leave it idle.
    expect(rt.status).toBe("working");
    expect(rt.blocks.map((b) => b.kind)).toEqual(["user"]);
  });

  it("getRuntime applies that thread's buffered events first", () => {
    queueThreadEvent("t1", { kind: "session_bound", seq: 1, session_id: "s" });
    queueThreadEvent("t2", { kind: "session_bound", seq: 1, session_id: "other" });
    expect(getRuntime("t1").sessionId).toBe("s");
    // Only t1 was flushed; t2 waits for the frame.
    expect(useThreadStore.getState().threads.t2).toBeUndefined();
    flushThreadEvents();
    expect(getRuntime("t2").sessionId).toBe("other");
  });

  it("flushes on its own on the next frame (or the timer fallback)", async () => {
    queueThreadEvent("t1", { kind: "session_bound", seq: 1, session_id: "s" });
    expect(useThreadStore.getState().threads.t1).toBeUndefined();
    await new Promise((r) => setTimeout(r, 150));
    expect(useThreadStore.getState().threads.t1.sessionId).toBe("s");
  });

  it("uses the 16 ms timer when requestAnimationFrame is unavailable", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", undefined);
    try {
      queueThreadEvent("t1", { kind: "session_bound", seq: 1, session_id: "s" });
      vi.advanceTimersByTime(15);
      expect(useThreadStore.getState().threads.t1).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(useThreadStore.getState().threads.t1.sessionId).toBe("s");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("applies events immediately when batching is off", () => {
    setThreadEventBatching(false);
    queueThreadEvent("t1", { kind: "session_bound", seq: 1, session_id: "s" });
    expect(useThreadStore.getState().threads.t1.sessionId).toBe("s");
  });
});

describe("no-op dispatch", () => {
  it("keeps the same state (and notifies nobody) when an event is ignored", () => {
    setThreadEventBatching(false);
    const { dispatch } = useThreadStore.getState();
    for (const e of streamText("Hi")) dispatch("t1", e);
    const before = useThreadStore.getState();
    const listener = vi.fn();
    const unsub = useThreadStore.subscribe(listener);
    dispatch("t1", m({ type: "keep_alive" }));
    dispatch("t1", m({ type: "system", subtype: "hook_started" }));
    dispatch("t1", se({ type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "x" } })); // unknown index
    dispatch("t1", se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } })); // text delta on a thinking block
    unsub();
    expect(listener).not.toHaveBeenCalled();
    expect(useThreadStore.getState()).toBe(before);
  });

  it("still creates a thread's runtime on its first (ignored) event", () => {
    useThreadStore.getState().dispatch("t9", m({ type: "keep_alive" }));
    expect(useThreadStore.getState().threads.t9).toEqual(initialRuntime());
  });

  it("skips the store update when a flushed batch changes nothing", () => {
    setThreadEventBatching(false);
    useThreadStore.getState().dispatch("t1", { kind: "session_bound", seq: 1, session_id: "s" });
    setThreadEventBatching(true);
    const before = useThreadStore.getState();
    queueThreadEvent("t1", m({ type: "keep_alive" }));
    flushThreadEvents();
    expect(useThreadStore.getState()).toBe(before);
  });
});

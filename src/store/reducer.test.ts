import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/cli-2.1.296-permission-deny-interrupt.ndjson?raw";
import type { ClaudeEvent, RawMessage } from "../ipc/types";
import { initialRuntime, reduce, resetUnknownTypeLog, type ThreadAction, type ThreadRuntime, type ViewBlock } from "./reducer";
import { syntheticSession } from "../test/fixtures/synthetic";

let seq = 0;
const m = (raw: RawMessage): ClaudeEvent => ({ kind: "message", seq: ++seq, raw });
const run = (actions: ThreadAction[], from: ThreadRuntime = initialRuntime(), start = 1000) =>
  actions.reduce((s, a, i) => reduce(s, a, start + i * 10), from);

const se = (event: Record<string, unknown>, parent: string | null = null, msgId = "msg_1"): ClaudeEvent =>
  m({ type: "stream_event", event, parent_tool_use_id: parent, api_message_id: msgId });
const asst = (content: unknown[], parent: string | null = null, id = "msg_1", extra: Record<string, unknown> = {}): ClaudeEvent =>
  m({ type: "assistant", message: { id, role: "assistant", content }, parent_tool_use_id: parent, ...extra });
const toolResult = (id: string, content: unknown, isError = false, parent: string | null = null, structured?: unknown): ClaudeEvent =>
  m({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    parent_tool_use_id: parent,
    ...(structured === undefined ? {} : { tool_use_result: structured }),
  });
const result = (extra: Record<string, unknown> = {}): ClaudeEvent => m({ type: "result", subtype: "success", is_error: false, ...extra });

const kinds = (blocks: ViewBlock[]) => blocks.map((b) => b.kind);

afterEach(() => resetUnknownTypeLog());

describe("reducer: streaming", () => {
  it("grows one text block from many text deltas, and the final assistant line replaces it", () => {
    let s = run([
      se({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo " } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }),
    ]);
    expect(kinds(s.blocks)).toEqual(["text"]);
    expect(s.blocks[0]).toMatchObject({ kind: "text", text: "Hello world", streaming: true });

    s = run([asst([{ type: "text", text: "Hello world!" }]), se({ type: "content_block_stop", index: 0 })], s);
    expect(kinds(s.blocks)).toEqual(["text"]);
    expect(s.blocks[0]).toMatchObject({ text: "Hello world!", streaming: false });
  });

  it("keeps one block per content index when one message streams thinking, text, and a tool", () => {
    const s = run([
      se({ type: "message_start", message: { id: "msg_1", content: [] } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      asst([{ type: "thinking", thinking: "hmm", signature: "x" }]),
      se({ type: "content_block_stop", index: 0 }),
      se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } }),
      asst([{ type: "text", text: "ok" }]),
      se({ type: "content_block_stop", index: 1 }),
      se({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} } }),
      se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":' } }),
      se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"ls"}' } }),
      se({ type: "content_block_stop", index: 2 }),
      asst([{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }]),
    ]);
    expect(kinds(s.blocks)).toEqual(["thinking", "text", "tool"]);
    expect(s.blocks[2]).toMatchObject({ kind: "tool", id: "tu_1", name: "Bash", input: { command: "ls" }, status: "running" });
  });

  it("renders thinking collapsed with a duration measured from block start to stop", () => {
    const s = [
      se({ type: "message_start", message: { id: "msg_1", content: [] } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "a" } }),
      se({ type: "content_block_stop", index: 0 }),
    ].reduce((st, a, i) => reduce(st, a, [0, 1000, 2000, 4200][i]), initialRuntime());
    expect(s.blocks[0]).toMatchObject({ kind: "thinking", text: "a", streaming: false, durationMs: 3200 });
  });

  it("uses the JSONL thinkingDurationMs when seeding", () => {
    const s = reduce(
      initialRuntime(),
      { kind: "seed", lines: [{ type: "assistant", thinkingDurationMs: 5100, message: { id: "m", content: [{ type: "thinking", thinking: "t" }] } }] },
      0,
    );
    expect(s.blocks[0]).toMatchObject({ kind: "thinking", durationMs: 5100 });
  });
});

describe("reducer: tools", () => {
  it("moves one tool card from running to done when its result arrives", () => {
    let s = run([asst([{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }])]);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ kind: "tool", status: "running", result: null });
    s = run([toolResult("tu_1", [{ type: "text", text: "line 1" }], false, null, { file: "x" })], s);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ kind: "tool", status: "done", result: { text: "line 1", isError: false, structured: { file: "x" } } });
  });

  it("puts the card in the error state when the result has is_error", () => {
    const s = run([asst([{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "x" } }]), toolResult("tu_1", "Denied", true)]);
    expect(s.blocks[0]).toMatchObject({ status: "error", result: { text: "Denied", isError: true } });
  });

  it("parses TodoWrite todos with their statuses", () => {
    const todos = [
      { content: "Plan", status: "completed", activeForm: "Planning" },
      { content: "Build", status: "in_progress", activeForm: "Building" },
      { content: "Ship", status: "pending", activeForm: "Shipping" },
    ];
    const s = run([asst([{ type: "tool_use", id: "tu_t", name: "TodoWrite", input: { todos } }])]);
    expect(s.blocks[0]).toMatchObject({ kind: "tool", name: "TodoWrite", todos });
  });

  it("nests subagent messages under their parent Task card", () => {
    const s = run([
      asst([{ type: "tool_use", id: "task_1", name: "Task", input: { description: "Explore", prompt: "look", subagent_type: "Explore" } }]),
      m({ type: "user", message: { role: "user", content: [{ type: "text", text: "look" }] }, parent_tool_use_id: "task_1" }),
      asst([{ type: "tool_use", id: "child_1", name: "Grep", input: { pattern: "foo" } }], "task_1", "msg_c"),
      toolResult("child_1", "3 matches", false, "task_1"),
      asst([{ type: "text", text: "found it" }], "task_1", "msg_c2"),
      m({ type: "system", subtype: "task_progress", task_id: "t", tool_use_id: "task_1", description: "Explore", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 500 }, last_tool_name: "Grep" }),
    ]);
    expect(kinds(s.blocks)).toEqual(["tool"]);
    const task = s.blocks[0] as Extract<ViewBlock, { kind: "tool" }>;
    expect(kinds(task.children)).toEqual(["tool", "text"]);
    expect(task.children[0]).toMatchObject({ id: "child_1", status: "done" });
    expect(task.progress).toMatchObject({ toolUses: 1, lastToolName: "Grep" });
    expect(task.status).toBe("running");
  });

  it("marks tools still running at the end of a turn as errored (interrupted)", () => {
    const s = run([asst([{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }]), result({ subtype: "error_during_execution", is_error: true })]);
    expect(s.blocks[0]).toMatchObject({ status: "error" });
  });
});

describe("reducer: errors, notices, unknown types", () => {
  it("renders nothing for an unknown type, logs it once, and keeps rendering later messages", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const s = run([
      m({ type: "brand_new_thing", foo: 1 }),
      m({ type: "brand_new_thing", foo: 2 }),
      asst([{ type: "text", text: "still here" }]),
    ]);
    expect(kinds(s.blocks)).toEqual(["text"]);
    expect(debug.mock.calls.filter((c) => String(c[0]).includes("brand_new_thing"))).toHaveLength(1);
    debug.mockRestore();
  });

  it("does not log or render known housekeeping messages", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const s = run([
      m({ type: "system", subtype: "hook_started" }),
      m({ type: "rate_limit_event" }),
      m({ type: "system", subtype: "thinking_tokens" }),
    ]);
    expect(s.blocks).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });

  it("turns error results, protocol errors, and assistant API errors into error blocks", () => {
    const s = run([
      result({ subtype: "error_max_turns", is_error: true, errors: ["Reached max turns"] }),
      { kind: "protocol_error", seq: 99, line: "garbage{" },
      asst([{ type: "text", text: "API Error: 529 overloaded" }], null, "msg_e", { error: "overloaded" }),
    ]);
    expect(kinds(s.blocks)).toEqual(["error", "error", "error"]);
    expect(s.blocks[0]).toMatchObject({ message: expect.stringContaining("Reached max turns") });
    expect(s.blocks[1]).toMatchObject({ message: expect.stringContaining("garbage{") });
    expect(s.blocks[2]).toMatchObject({ message: "API Error: 529 overloaded" });
  });

  it("shows a compact boundary notice", () => {
    const s = run([m({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 100000 } })]);
    expect(s.blocks[0]).toMatchObject({ kind: "notice", variant: "compact" });
  });
});

describe("reducer: runtime state", () => {
  it("tracks status, init, system/init, permissions, and a bounded stderr tail", () => {
    let s = run([
      { kind: "status", seq: 1, status: "starting", detail: null, stderr_tail: null, reconnecting: false },
      { kind: "initialized", seq: 2, response: { commands: [], current_permission_mode: "default" } },
      { kind: "session_bound", seq: 3, session_id: "sess" },
      m({ type: "system", subtype: "init", model: "opus", permissionMode: "plan", slash_commands: ["/x"], tools: [] }),
      {
        kind: "permission_request",
        seq: 5,
        request_id: "r1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
        diff: null,
      },
    ]);
    expect(s).toMatchObject({ status: "starting", sessionId: "sess", model: "opus", permissionMode: "plan" });
    expect(s.lastSeq).toBeGreaterThanOrEqual(5);
    expect(s.init).toMatchObject({ current_permission_mode: "default" });
    expect(s.systemInit).toMatchObject({ slash_commands: ["/x"] });
    expect(s.pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    s = run([{ kind: "permission_resolved", seq: 6, request_id: "r1", reason: "interrupt" }], s);
    expect(s.pendingPermissions).toEqual([]);
    for (let i = 0; i < 500; i++) s = reduce(s, { kind: "stderr", seq: 10 + i, text: `line ${i} ${"x".repeat(40)}` }, 0);
    expect(s.stderrTail.length).toBeLessThanOrEqual(8192);
    expect(s.stderrTail).toContain("line 499");
  });

  it("adds an optimistic user block and binds its uuid from the next assistant message", () => {
    const s = run([
      { kind: "local_user", id: "u1", content: [{ type: "text", text: "hi there" }], ts: 5 },
      asst([{ type: "text", text: "hello" }], null, "msg_1", { user_message_uuid: "uuid-1" }),
    ]);
    expect(s.blocks[0]).toMatchObject({ kind: "user", text: "hi there", uuid: "uuid-1" });
  });

  it("seeds a transcript from session JSONL lines, skipping meta and unknown line types", () => {
    const s = reduce(
      initialRuntime(),
      {
        kind: "seed",
        lines: [
          { type: "file-history-snapshot" },
          { type: "user", uuid: "u-1", timestamp: "2026-10-14T10:00:00.000Z", message: { role: "user", content: "fix it" } },
          { type: "user", isMeta: true, message: { role: "user", content: "<meta>" } },
          { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/f" } }] } },
          { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
          { type: "assistant", message: { id: "a2", content: [{ type: "text", text: "done" }] } },
          { type: "ai-title", aiTitle: "x" },
        ],
      },
      0,
    );
    expect(kinds(s.blocks)).toEqual(["user", "tool", "text"]);
    expect(s.blocks[0]).toMatchObject({ uuid: "u-1", text: "fix it", ts: Date.parse("2026-10-14T10:00:00.000Z") });
    expect(s.blocks[1]).toMatchObject({ status: "done" });
  });
});

describe("reducer: recorded CLI fixture", () => {
  it("replays the spike's permission-deny + interrupt session into user/tool/thinking/text blocks and ends idle", () => {
    const lines = fixture
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { dir: "in" | "out"; msg: RawMessage });
    // Translate the raw CLI stream the way the Rust actor does (control traffic is consumed there).
    const actions: ThreadAction[] = [{ kind: "status", seq: 0, status: "starting", detail: null, stderr_tail: null, reconnecting: false }];
    let n = 0;
    for (const { dir, msg } of lines) {
      n++;
      if (dir === "out") {
        if (msg.type === "user") {
          const content = (msg.message as { content: unknown[] }).content;
          actions.push({ kind: "local_user", id: `local-${n}`, content, ts: n });
        } else if (msg.type === "control_response") {
          const resp = msg.response as { request_id: string };
          actions.push({ kind: "permission_answered", requestId: resp.request_id });
        }
        continue;
      }
      if (msg.type === "control_response") {
        const resp = msg.response as { request_id: string; response: Record<string, unknown> };
        if (resp.request_id === "init-1") {
          actions.push({ kind: "initialized", seq: n, response: resp.response });
          actions.push({ kind: "status", seq: n, status: "idle", detail: null, stderr_tail: null, reconnecting: false });
        }
        continue;
      }
      if (msg.type === "control_request") {
        const req = msg.request as Record<string, unknown>;
        actions.push({ kind: "permission_request", seq: n, request_id: msg.request_id as string, request: req as never, diff: null });
        continue;
      }
      actions.push({ kind: "message", seq: n, raw: msg });
    }
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const s = run(actions);
    debug.mockRestore();

    expect(kinds(s.blocks)).toEqual(["user", "tool", "thinking", "text", "user", "thinking", "notice"]);
    expect(s.blocks[1]).toMatchObject({ kind: "tool", name: "Bash", status: "error", result: { text: "Denied by Speedy protocol probe.", isError: true } });
    expect(s.blocks[3]).toMatchObject({ kind: "text", text: "denied", streaming: false });
    expect(s.blocks[6]).toMatchObject({ kind: "notice", variant: "interrupted" });
    expect(s.pendingPermissions).toEqual([]);
    expect(s.sessionId).toBeNull(); // session_bound comes from the actor, not raw lines
    expect(s.systemInit).toMatchObject({ session_id: "04f13abf-e3ec-4946-98c7-67cc5cced041" });
    expect(s.status).toBe("idle");
    expect(s.lastResult).toMatchObject({ subtype: "error_during_execution" });
  });
});

describe("reducer: performance", () => {
  it("reduces a 2,000-message synthetic session in under 200 ms", () => {
    const events = syntheticSession(2000);
    const t0 = performance.now();
    const s = run(events);
    const elapsed = performance.now() - t0;
    expect(s.blocks.length).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(200);
  });
});

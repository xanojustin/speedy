import { describe, expect, it } from "vitest";
import type { ClaudeEvent, RawMessage } from "../ipc/types";
import { initialRuntime, reduce, type ThreadAction, type ThreadRuntime } from "../store/reducer";
import { deriveActivity, deriveTodos } from "./activity";

let seq = 0;
const m = (raw: RawMessage): ClaudeEvent => ({ kind: "message", seq: ++seq, raw });
const run = (actions: ThreadAction[], from: ThreadRuntime = initialRuntime()) => actions.reduce((s, a, i) => reduce(s, a, 1000 + i * 10), from);
const tool = (id: string, name: string, input: Record<string, unknown>, msg = `msg_${id}`): ClaudeEvent =>
  m({ type: "assistant", message: { id: msg, role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null });
const done = (id: string, structured?: unknown, isError = false): ClaudeEvent =>
  m({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] },
    parent_tool_use_id: null,
    ...(structured === undefined ? {} : { tool_use_result: structured }),
  });
const user = (text: string): ThreadAction => ({ kind: "user_sent", seq: 0, id: `u-${text}`, content: [{ type: "text", text }] });
const bg = (tasks: Record<string, unknown>[]): ClaudeEvent => m({ type: "system", subtype: "background_tasks_changed", tasks });

describe("deriveTodos", () => {
  it("takes the latest TodoWrite list", () => {
    const s = run([
      tool("t1", "TodoWrite", { todos: [{ content: "A", status: "in_progress", activeForm: "Doing A" }] }),
      tool("t2", "TodoWrite", { todos: [{ content: "A", status: "completed" }, { content: "B", status: "pending" }] }),
    ]);
    expect(deriveTodos(s.blocks).map((t) => [t.content, t.status])).toEqual([
      ["A", "completed"],
      ["B", "pending"],
    ]);
  });

  it("replays TaskCreate and TaskUpdate by the task ids the CLI returned", () => {
    const s = run([
      tool("c1", "TaskCreate", { subject: "Write tests", description: "x", activeForm: "Writing tests" }),
      done("c1", { task: { id: "1", subject: "Write tests" } }),
      tool("c2", "TaskCreate", { subject: "Ship", description: "y" }),
      done("c2", { task: { id: "2", subject: "Ship" } }),
      tool("c3", "TaskCreate", { subject: "Drop me", description: "z" }),
      done("c3", { task: { id: "3", subject: "Drop me" } }),
      tool("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
      done("u1", { success: true }),
      tool("u2", "TaskUpdate", { taskId: "2", status: "in_progress", subject: "Ship it" }),
      tool("u3", "TaskUpdate", { taskId: "3", status: "deleted" }),
      tool("u4", "TaskUpdate", { taskId: "1", status: "pending" }),
      done("u4", undefined, true),
    ]);
    expect(deriveTodos(s.blocks).map((t) => [t.id, t.content, t.status])).toEqual([
      ["1", "Write tests", "completed"],
      ["2", "Ship it", "in_progress"],
    ]);
  });
});

describe("deriveActivity", () => {
  it("lists this turn's agents with their progress, and running agents from earlier turns", () => {
    const s = run([
      user("first"),
      tool("a_old", "Agent", { description: "Old finished", prompt: "p", subagent_type: "Explore" }),
      done("a_old"),
      tool("a_bg", "Agent", { description: "Long job", prompt: "p", run_in_background: true }),
      done("a_bg", { status: "async_launched", agentId: "task-bg", description: "Long job", prompt: "p", outputFile: "/tmp/x" }),
      bg([{ task_id: "task-bg", task_type: "local_agent", description: "Long job" }, { task_id: "sh1", task_type: "local_bash", description: "npm run dev" }]),
      user("second"),
      tool("a_new", "Agent", { description: "Look around", prompt: "p", subagent_type: "Explore" }),
      m({ type: "system", subtype: "task_progress", task_id: "task-new", tool_use_id: "a_new", description: "Look around", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 1 }, last_tool_name: "Grep" }),
    ]);
    const a = deriveActivity(s.blocks, s.backgroundTasks);
    expect(a.agents.map((x) => [x.id, x.state, x.background])).toEqual([
      ["a_bg", "running", true],
      ["a_new", "running", false],
    ]);
    expect(a.agents[1]).toMatchObject({ label: "Explore", description: "Look around", toolUses: 3, totalTokens: 1200, lastToolName: "Grep" });
    expect(a.others.map((t) => t.taskId)).toEqual(["sh1"]);
  });

  it("marks a background agent done once it leaves the live set", () => {
    const s = run([
      user("go"),
      tool("a_bg", "Agent", { description: "Long job", prompt: "p", run_in_background: true }),
      done("a_bg", { status: "async_launched", agentId: "task-bg", description: "Long job", prompt: "p", outputFile: "/tmp/x" }),
      bg([]),
    ]);
    expect(deriveActivity(s.blocks, s.backgroundTasks).agents.map((x) => x.state)).toEqual(["completed"]);
  });

  it("reports failed and stopped agents", () => {
    const s = run([
      user("go"),
      tool("a1", "Task", { description: "Breaks", prompt: "p" }),
      done("a1", undefined, true),
      tool("a2", "Task", { description: "Halted", prompt: "p" }),
      m({ type: "system", subtype: "task_notification", task_id: "t2", tool_use_id: "a2", status: "stopped", summary: "stopped" }),
    ]);
    expect(deriveActivity(s.blocks, s.backgroundTasks).agents.map((x) => x.state)).toEqual(["failed", "stopped"]);
  });
});

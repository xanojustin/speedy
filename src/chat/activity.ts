// What the agent is tracking right now, derived from the transcript: its todo list (TodoWrite, or
// the TaskCreate/TaskUpdate tools) and its subagents. Pure; the activity panel renders the result.
import type { BackgroundTask } from "../store/reducer";
import type { TodoItem, ToolBlock, ViewBlock } from "../store/threadStore";
import { toolSummary } from "./messages/ToolCard";

export interface ActivityTodo extends TodoItem {
  id: string;
}

export type AgentState = "running" | "completed" | "failed" | "stopped";

export interface ActivityAgent {
  /** The Task/Agent tool_use id. */
  id: string;
  label: string;
  description: string | null;
  state: AgentState;
  /** Launched with run_in_background (it outlives the turn that started it). */
  background: boolean;
  toolUses: number | null;
  totalTokens: number | null;
  lastToolName: string | null;
  summary: string | null;
}

export interface Activity {
  todos: ActivityTodo[];
  agents: ActivityAgent[];
  /** Live background tasks that aren't one of `agents` (shells, workflows, agents from before a reload). */
  others: BackgroundTask[];
}

const isAgentTool = (b: ViewBlock): b is ToolBlock => b.kind === "tool" && (b.name === "Task" || b.name === "Agent");

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** The todo list after replaying every top-level todo tool call in order. */
export function deriveTodos(blocks: ViewBlock[]): ActivityTodo[] {
  let todos: ActivityTodo[] = [];
  for (const b of blocks) {
    if (b.kind !== "tool" || b.status === "error") continue;
    if (b.name === "TodoWrite" && b.todos) {
      todos = b.todos.map((t, i) => ({ ...t, id: `${b.id}:${i}` }));
    } else if (b.name === "TaskCreate") {
      const subject = typeof b.input.subject === "string" ? b.input.subject : null;
      if (!subject) continue;
      const task = obj(obj(b.result?.structured)?.task);
      const id = typeof task?.id === "string" ? task.id : b.id;
      const activeForm = typeof b.input.activeForm === "string" ? b.input.activeForm : undefined;
      todos = [...todos, { id, content: subject, status: "pending", ...(activeForm ? { activeForm } : {}) }];
    } else if (b.name === "TaskUpdate") {
      const id = typeof b.input.taskId === "string" ? b.input.taskId : null;
      if (!id) continue;
      const { status, subject, activeForm } = b.input;
      if (status === "deleted") {
        todos = todos.filter((t) => t.id !== id);
        continue;
      }
      todos = todos.map((t) =>
        t.id !== id
          ? t
          : {
              ...t,
              ...(typeof status === "string" ? { status } : {}),
              ...(typeof subject === "string" ? { content: subject } : {}),
              ...(typeof activeForm === "string" ? { activeForm } : {}),
            },
      );
    }
  }
  return todos;
}

function agentState(b: ToolBlock, live: Set<string>, asyncId: string | null): AgentState {
  const taskId = b.progress?.taskId ?? asyncId;
  if (taskId && live.has(taskId)) return "running";
  if (b.progress && b.progress.state !== "running") return b.progress.state;
  if (b.status === "running") return "running";
  if (b.status === "error") return "failed";
  // A backgrounded agent's tool call returns at launch, so past here it has left the live set.
  return "completed";
}

/**
 * Subagents worth showing: everything launched since the latest user message, plus any agent from
 * an earlier turn that is still running.
 */
export function deriveActivity(blocks: ViewBlock[], backgroundTasks: BackgroundTask[]): Activity {
  const live = new Set(backgroundTasks.map((t) => t.taskId));
  let turnStart = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "user") {
      turnStart = i;
      break;
    }
  }

  const agents: ActivityAgent[] = [];
  const matched = new Set<string>();
  blocks.forEach((b, i) => {
    if (!isAgentTool(b)) return;
    const structured = obj(b.result?.structured);
    const asyncId = structured?.status === "async_launched" && typeof structured.agentId === "string" ? structured.agentId : null;
    const state = agentState(b, live, asyncId);
    if (i < turnStart && state !== "running") return;
    const taskId = b.progress?.taskId ?? asyncId;
    if (taskId) matched.add(taskId);
    const { label, detail } = toolSummary(b);
    const p = b.progress;
    agents.push({
      id: b.id,
      label,
      description: detail ?? p?.description ?? null,
      state,
      background: asyncId !== null || b.input.run_in_background === true,
      toolUses: p?.toolUses ?? null,
      totalTokens: p?.totalTokens ?? null,
      lastToolName: p?.lastToolName ?? null,
      summary: p?.summary ?? null,
    });
  });

  return {
    todos: deriveTodos(blocks),
    agents,
    others: backgroundTasks.filter((t) => !matched.has(t.taskId)),
  };
}

export const isEmptyActivity = (a: Activity) => a.todos.length === 0 && a.agents.length === 0 && a.others.length === 0;

// U8: pure reducer from the actor's ClaudeEvent stream (and a few local actions) to a thread's
// runtime state and transcript view blocks. No IO here; `now` is passed in so durations are testable.
import type { CanUseToolRequest, ClaudeEvent, FileDiff, PermissionMode, RawMessage, ThreadStatus } from "../ipc/types";
import type { SDKAssistantMessage, SDKPartialAssistantMessage, SDKResultMessage, SDKUserMessage } from "./sdk";

// ---------- view blocks ----------

export type ToolStatus = "running" | "done" | "error";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
}

export interface ToolResultView {
  /** Flattened text of the tool_result content. */
  text: string;
  isError: boolean;
  /** The structured `tool_use_result` / `toolUseResult` field, when present. */
  structured: unknown;
  images: number;
}

export interface TaskProgress {
  description: string | null;
  lastToolName: string | null;
  toolUses: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  summary: string | null;
  state: "running" | "completed" | "failed" | "stopped";
}

export type ViewBlock =
  | {
      kind: "user";
      id: string;
      /** CLI message uuid (rewind target); null until the CLI reports it. */
      uuid: string | null;
      text: string;
      images: number;
      ts: number | null;
    }
  | { kind: "text"; id: string; messageId: string; text: string; streaming: boolean; ts: number | null }
  | {
      kind: "thinking";
      id: string;
      messageId: string;
      text: string;
      streaming: boolean;
      startedAt: number | null;
      durationMs: number | null;
      ts: number | null;
    }
  | {
      kind: "tool";
      /** The tool_use id. */
      id: string;
      messageId: string;
      name: string;
      input: Record<string, unknown>;
      /** Accumulated input_json_delta text while the input streams. */
      partialInput: string | null;
      status: ToolStatus;
      result: ToolResultView | null;
      /** Set for TodoWrite. */
      todos: TodoItem[] | null;
      /** Subagent (Task/Agent) messages, i.e. those whose parent_tool_use_id is this tool. */
      children: ViewBlock[];
      progress: TaskProgress | null;
      elapsedSeconds: number | null;
      ts: number | null;
    }
  | { kind: "error"; id: string; title: string; message: string; ts: number | null }
  | { kind: "notice"; id: string; variant: "compact" | "interrupted" | "info" | "warning"; text: string; ts: number | null };

export type ToolBlock = Extract<ViewBlock, { kind: "tool" }>;

// ---------- runtime ----------

export interface PendingPermission {
  requestId: string;
  request: CanUseToolRequest;
  diff: FileDiff[] | null;
  seq: number;
}

export interface QueuedMessage {
  id: string;
  content: unknown[];
}

export interface ThreadRuntime {
  status: ThreadStatus;
  detail: string | null;
  stderrTail: string;
  reconnecting: boolean;
  /** Set by a manual retry until the thread is idle again or fails. */
  retrying: boolean;
  sessionId: string | null;
  /** The `initialize` control_response payload (commands, models, account, current_permission_mode, …). */
  init: Record<string, unknown> | null;
  /** Latest raw `system/init` message (slash_commands, model, permissionMode, tools, …). */
  systemInit: Record<string, unknown> | null;
  blocks: ViewBlock[];
  pendingPermissions: PendingPermission[];
  queue: QueuedMessage[];
  model: string | null;
  permissionMode: PermissionMode | null;
  contextUsage: unknown | null;
  lastResult: Record<string, unknown> | null;
  lastSeq: number;
  /** "loading" while a session JSONL is being seeded, "failed" if that failed. */
  seed: "none" | "loading" | "done" | "failed";
  /** Internal: streaming bookkeeping keyed by parent_tool_use_id ("" for top level). */
  streams: Record<string, StreamCursor>;
}

interface StreamCursor {
  messageId: string;
  /** content index -> block id */
  blocks: Record<number, string>;
}

export const STDERR_TAIL_MAX = 8192;

export function initialRuntime(): ThreadRuntime {
  return {
    status: "not_started",
    detail: null,
    stderrTail: "",
    reconnecting: false,
    retrying: false,
    sessionId: null,
    init: null,
    systemInit: null,
    blocks: [],
    pendingPermissions: [],
    queue: [],
    model: null,
    permissionMode: null,
    contextUsage: null,
    lastResult: null,
    lastSeq: 0,
    seed: "none",
    streams: {},
  };
}

// ---------- actions ----------

export type LocalAction =
  | { kind: "local_user"; id: string; content: unknown[]; ts: number }
  | { kind: "seed"; lines: Record<string, unknown>[] }
  | { kind: "seed_state"; seed: ThreadRuntime["seed"] }
  | { kind: "local_notice"; variant: "info" | "warning"; text: string }
  | { kind: "local_status"; status: ThreadStatus; detail?: string | null }
  | { kind: "retrying" }
  | { kind: "permission_answered"; requestId: string }
  | { kind: "permission_refreshed"; requestId: string; diff: FileDiff[] | null }
  | { kind: "queue_add"; item: QueuedMessage }
  | { kind: "queue_remove"; id: string }
  | { kind: "context_usage"; usage: unknown };

export type ThreadAction = ClaudeEvent | LocalAction;

// ---------- unknown-type logging ----------

const loggedUnknown = new Set<string>();
export function resetUnknownTypeLog() {
  loggedUnknown.clear();
}
function logUnknown(key: string, raw: unknown) {
  if (loggedUnknown.has(key)) return;
  loggedUnknown.add(key);
  console.debug(`[speedy] unhandled stream message type: ${key}`, raw);
}

/** Message types and system subtypes that are expected and intentionally not rendered. */
const SILENT_TYPES = new Set([
  "rate_limit_event",
  "keep_alive",
  "auth_status",
  "tool_use_summary",
  "prompt_suggestion",
  "control_request",
  "control_response",
  "control_cancel_request",
  "streamlined_text",
  "streamlined_tool_use_summary",
  "conversation_reset",
]);
const SILENT_SYSTEM = new Set([
  "hook_started",
  "hook_progress",
  "hook_response",
  "status",
  "thinking_tokens",
  "commands_changed",
  "api_retry",
  "permission_denied",
  "notification",
  "files_persisted",
  "session_state_changed",
  "background_tasks_changed",
  "memory_recall",
  "elicitation_complete",
  "plugin_install",
  "control_request_progress",
  "worker_shutting_down",
  "mirror_error",
  "task_started",
  "stop_hook_summary",
  "active_goal",
  "model_refusal_fallback",
]);

// ---------- block tree helpers ----------

type Path = number[];

/**
 * Seeding builds a whole transcript from scratch before anyone can see it, so it reduces into
 * mutable arrays (no per-line copies) and keeps id indexes instead of walking the tree per line.
 * Invariants while a draft is active: blocks are only appended or replaced in place (never removed
 * or reordered), nothing is streaming, and every array was created by this seed.
 */
interface SeedDraft {
  /** tool id -> path of the newest tool block with that id. */
  toolPaths: Map<string, Path>;
  /** messageId -> number of text/thinking blocks with that messageId. */
  textCounts: Map<string, number>;
}
let draft: SeedDraft | null = null;

/** Finds a block by predicate, searching newest-first and into tool children. */
function locate(blocks: ViewBlock[], pred: (b: ViewBlock) => boolean): Path | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (pred(b)) return [i];
    if (b.kind === "tool" && b.children.length) {
      const sub = locate(b.children, pred);
      if (sub) return [i, ...sub];
    }
  }
  return null;
}

/** Replaces the block at `path`. Returns `blocks` itself when `fn` returns the same block. */
function updateAt(blocks: ViewBlock[], path: Path, fn: (b: ViewBlock) => ViewBlock): ViewBlock[] {
  const [i, ...rest] = path;
  let nb: ViewBlock;
  if (rest.length === 0) {
    nb = fn(blocks[i]);
  } else {
    const parent = blocks[i] as ToolBlock;
    const children = updateAt(parent.children, rest, fn);
    nb = children === parent.children ? parent : { ...parent, children };
  }
  if (nb === blocks[i]) return blocks;
  if (draft) {
    blocks[i] = nb;
    return blocks;
  }
  const next = blocks.slice();
  next[i] = nb;
  return next;
}

const findTool = (blocks: ViewBlock[], id: string) =>
  draft ? (draft.toolPaths.get(id) ?? null) : locate(blocks, (b) => b.kind === "tool" && b.id === id);

/** Appends `block` to `list` (in place while seeding), recording it in the seed indexes. */
function push(list: ViewBlock[], block: ViewBlock, parentPath: Path | null): ViewBlock[] {
  if (!draft) return [...list, block];
  if (block.kind === "tool") draft.toolPaths.set(block.id, [...(parentPath ?? []), list.length]);
  if (block.kind === "text" || block.kind === "thinking") draft.textCounts.set(block.messageId, (draft.textCounts.get(block.messageId) ?? 0) + 1);
  list.push(block);
  return list;
}

/** Appends to the top level, or to the children of the tool `parent` (falls back to top level). */
function append(blocks: ViewBlock[], parent: string | null, block: ViewBlock): ViewBlock[] {
  if (parent) {
    const path = findTool(blocks, parent);
    if (path) {
      return updateAt(blocks, path, (b) => {
        const t = b as ToolBlock;
        return draft ? (push(t.children, block, path), t) : { ...t, children: push(t.children, block, path) };
      });
    }
  }
  return push(blocks, block, null);
}

function mapAll(blocks: ViewBlock[], fn: (b: ViewBlock) => ViewBlock): ViewBlock[] {
  let changed = false;
  const out = blocks.map((b) => {
    let nb = fn(b);
    if (nb.kind === "tool" && nb.children.length) {
      const kids = mapAll(nb.children, fn);
      if (kids !== nb.children) nb = { ...nb, children: kids };
    }
    if (nb !== b) changed = true;
    return nb;
  });
  return changed ? out : blocks;
}

// ---------- content helpers ----------

type ContentBlock = { type: string; [k: string]: unknown };

function asContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content.filter((c) => c && typeof c === "object") as ContentBlock[]) : [];
}

function flattenText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  let text = "";
  let images = 0;
  for (const c of asContent(content)) {
    if (c.type === "text" && typeof c.text === "string") text += (text ? "\n" : "") + c.text;
    else if (c.type === "image") images++;
  }
  return { text, images };
}

function parseTodos(input: Record<string, unknown>): TodoItem[] | null {
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;
  return todos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      content: String(t.content ?? ""),
      status: String(t.status ?? "pending"),
      ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
    }));
}

function tsOf(raw: Record<string, unknown>): number | null {
  if (typeof raw.timestamp === "string") {
    const t = Date.parse(raw.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

const INTERRUPT_RE = /^\[Request interrupted by user/;

function makeTool(c: ContentBlock, messageId: string, ts: number | null): ToolBlock {
  const input = (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>;
  const name = String(c.name ?? "tool");
  return {
    kind: "tool",
    id: String(c.id),
    messageId,
    name,
    input,
    partialInput: null,
    status: "running",
    result: null,
    todos: name === "TodoWrite" ? parseTodos(input) : null,
    children: [],
    progress: null,
    elapsedSeconds: null,
    ts,
  };
}

// ---------- message handlers ----------

function onAssistant(s: ThreadRuntime, raw: RawMessage, now: number, seeding: boolean): ThreadRuntime {
  const msg = raw as unknown as SDKAssistantMessage & { thinkingDurationMs?: number };
  const message = (msg.message ?? {}) as { id?: string; content?: unknown };
  const messageId = String(message.id ?? `m-${now}-${s.blocks.length}`);
  const parent = msg.parent_tool_use_id ?? null;
  const ts = tsOf(raw) ?? (seeding ? null : now);
  let blocks = s.blocks;

  blocks = bindUserUuid(blocks, (raw as { user_message_uuid?: string }).user_message_uuid);

  if (msg.error) {
    const { text } = flattenText(message.content);
    return { ...s, blocks: append(blocks, parent, { kind: "error", id: `err-${messageId}`, title: "API error", message: text || String(msg.error), ts }) };
  }

  for (const c of asContent(message.content)) {
    if (c.type === "tool_use") {
      const id = String(c.id);
      const path = findTool(blocks, id);
      const fresh = makeTool(c, messageId, ts);
      if (path) {
        blocks = updateAt(blocks, path, (b) => {
          const t = b as ToolBlock;
          return { ...t, name: fresh.name, input: fresh.input, todos: fresh.todos, partialInput: null };
        });
      } else {
        blocks = append(blocks, parent, fresh);
      }
    } else if (c.type === "text" || c.type === "thinking" || c.type === "redacted_thinking") {
      const kind = c.type === "text" ? "text" : "thinking";
      const text = String((c.type === "text" ? c.text : c.thinking) ?? "");
      // With partial messages on, a streamed block for this message already exists: finalize it.
      // (Nothing streams while seeding, so the walk is skipped there.)
      const path = draft
        ? null
        : locate(blocks, (b) => (b.kind === "text" || b.kind === "thinking") && b.kind === kind && b.messageId === messageId && b.streaming);
      if (path) {
        blocks = updateAt(blocks, path, (b) => {
          if (b.kind === "thinking") {
            const durationMs = b.durationMs ?? (b.startedAt != null ? now - b.startedAt : null);
            return { ...b, text: text || b.text, streaming: false, durationMs };
          }
          return { ...(b as Extract<ViewBlock, { kind: "text" }>), text, streaming: false };
        });
      } else {
        const id = `${messageId}:${kind}:${countByMessage(blocks, messageId)}`;
        if (kind === "text") {
          if (!text.trim()) continue;
          blocks = append(blocks, parent, { kind: "text", id, messageId, text, streaming: false, ts });
        } else {
          const durationMs = typeof msg.thinkingDurationMs === "number" ? msg.thinkingDurationMs : null;
          blocks = append(blocks, parent, { kind: "thinking", id, messageId, text, streaming: false, startedAt: null, durationMs, ts });
        }
      }
    }
  }
  return { ...s, blocks };
}

function countByMessage(blocks: ViewBlock[], messageId: string): number {
  if (draft) return draft.textCounts.get(messageId) ?? 0;
  let n = 0;
  const walk = (list: ViewBlock[]) => {
    for (const b of list) {
      if ((b.kind === "text" || b.kind === "thinking") && b.messageId === messageId) n++;
      if (b.kind === "tool") walk(b.children);
    }
  };
  walk(blocks);
  return n;
}

function bindUserUuid(blocks: ViewBlock[], uuid: string | undefined): ViewBlock[] {
  if (!uuid) return blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "user") continue;
    if (b.uuid) return blocks; // newest user block already bound
    const next = draft ? blocks : blocks.slice();
    next[i] = { ...b, uuid };
    return next;
  }
  return blocks;
}

function onStreamEvent(s: ThreadRuntime, raw: RawMessage, now: number): ThreadRuntime {
  const msg = raw as unknown as SDKPartialAssistantMessage & { api_message_id?: string };
  const ev = msg.event as unknown as { type: string; index?: number; message?: { id?: string }; content_block?: ContentBlock; delta?: Record<string, unknown> };
  const parent = msg.parent_tool_use_id ?? null;
  const key = parent ?? "";
  let blocks = bindUserUuid(s.blocks, (raw as { user_message_uuid?: string }).user_message_uuid);
  let streams = s.streams;
  let cursor = streams[key];

  if (ev.type === "message_start") {
    const messageId = String(ev.message?.id ?? msg.api_message_id ?? `m-${now}`);
    return { ...s, blocks, streams: { ...streams, [key]: { messageId, blocks: {} } } };
  }
  const messageId = msg.api_message_id ?? cursor?.messageId;
  if (!messageId) return blocks === s.blocks ? s : { ...s, blocks };
  if (!cursor || cursor.messageId !== messageId) {
    cursor = { messageId, blocks: {} };
  }
  const index = ev.index ?? 0;

  if (ev.type === "content_block_start" && ev.content_block) {
    const c = ev.content_block;
    let id: string | null = null;
    if (c.type === "text") {
      id = `${messageId}:${index}`;
      blocks = append(blocks, parent, { kind: "text", id, messageId, text: String(c.text ?? ""), streaming: true, ts: now });
    } else if (c.type === "thinking" || c.type === "redacted_thinking") {
      id = `${messageId}:${index}`;
      blocks = append(blocks, parent, {
        kind: "thinking",
        id,
        messageId,
        text: String(c.thinking ?? ""),
        streaming: true,
        startedAt: now,
        durationMs: null,
        ts: now,
      });
    } else if (c.type === "tool_use") {
      id = String(c.id);
      if (!findTool(blocks, id)) blocks = append(blocks, parent, { ...makeTool(c, messageId, now), partialInput: "" });
    }
    if (id) cursor = { ...cursor, blocks: { ...cursor.blocks, [index]: id } };
    streams = { ...streams, [key]: cursor };
    return { ...s, blocks, streams };
  }

  const blockId = cursor.blocks[index];
  if (!blockId) return blocks === s.blocks ? s : { ...s, blocks };
  const path = locate(blocks, (b) => b.id === blockId && b.kind !== "user");
  if (!path) return blocks === s.blocks ? s : { ...s, blocks };

  if (ev.type === "content_block_delta" && ev.delta) {
    const d = ev.delta;
    blocks = updateAt(blocks, path, (b) => {
      if (d.type === "text_delta" && b.kind === "text" && b.streaming) return { ...b, text: b.text + String(d.text ?? "") };
      if (d.type === "thinking_delta" && b.kind === "thinking" && b.streaming) return { ...b, text: b.text + String(d.thinking ?? "") };
      if (d.type === "input_json_delta" && b.kind === "tool" && b.partialInput !== null) {
        return { ...b, partialInput: b.partialInput + String(d.partial_json ?? "") };
      }
      return b;
    });
  } else if (ev.type === "content_block_stop") {
    blocks = updateAt(blocks, path, (b) => {
      if (b.kind === "thinking") {
        const durationMs = b.durationMs ?? (b.startedAt != null ? now - b.startedAt : null);
        return { ...b, streaming: false, durationMs };
      }
      if (b.kind === "text") return b.streaming ? { ...b, streaming: false } : b;
      if (b.kind === "tool" && b.partialInput !== null) {
        let input = b.input;
        try {
          if (b.partialInput) input = JSON.parse(b.partialInput) as Record<string, unknown>;
        } catch {
          /* keep the start input; the final assistant line carries the parsed input */
        }
        return { ...b, input, todos: b.name === "TodoWrite" ? parseTodos(input) : b.todos, partialInput: null };
      }
      return b;
    });
  }
  return blocks === s.blocks ? s : { ...s, blocks };
}

function onUser(s: ThreadRuntime, raw: RawMessage, now: number, seeding: boolean): ThreadRuntime {
  const msg = raw as unknown as SDKUserMessage & { toolUseResult?: unknown; isMeta?: boolean; uuid?: string };
  if (msg.isMeta || (msg as { isSynthetic?: boolean }).isSynthetic) return s;
  const parent = msg.parent_tool_use_id ?? null;
  const content = asContent((msg.message as { content?: unknown })?.content);
  const ts = tsOf(raw) ?? (seeding ? null : now);
  const structured = msg.tool_use_result ?? msg.toolUseResult;
  let blocks = s.blocks;
  const textParts: string[] = [];
  let images = 0;

  for (const c of content) {
    if (c.type === "tool_result") {
      const path = findTool(blocks, String(c.tool_use_id));
      if (!path) continue;
      const flat = flattenText(c.content);
      const isError = c.is_error === true;
      blocks = updateAt(blocks, path, (b) => ({
        ...(b as ToolBlock),
        status: isError ? "error" : "done",
        partialInput: null,
        result: { text: flat.text, isError, structured: structured ?? null, images: flat.images },
      }));
    } else if (c.type === "text" && typeof c.text === "string") {
      textParts.push(c.text);
    } else if (c.type === "image") {
      images++;
    }
  }

  if (textParts.length || images) {
    const text = textParts.join("\n");
    if (INTERRUPT_RE.test(text)) {
      blocks = append(blocks, parent, { kind: "notice", id: `int-${msg.uuid ?? now}-${blocks.length}`, variant: "interrupted", text: "Interrupted by user", ts });
    } else if (!parent) {
      // A subagent's prompt (parent set) is already shown as the Task card's input.
      const uuid = typeof msg.uuid === "string" ? msg.uuid : null;
      blocks = push(blocks, { kind: "user", id: uuid ?? `user-${now}-${blocks.length}`, uuid, text, images, ts }, null);
    }
  }
  return blocks === s.blocks ? s : { ...s, blocks };
}

function onResult(s: ThreadRuntime, raw: RawMessage, now: number): ThreadRuntime {
  const r = raw as unknown as SDKResultMessage & { errors?: string[]; result?: string };
  let blocks = mapAll(s.blocks, (b) => {
    if (b.kind === "tool" && b.status === "running") return { ...b, status: "error" as const, partialInput: null };
    if ((b.kind === "text" || b.kind === "thinking") && b.streaming) {
      return b.kind === "thinking"
        ? { ...b, streaming: false, durationMs: b.durationMs ?? (b.startedAt != null ? now - b.startedAt : null) }
        : { ...b, streaming: false };
    }
    return b;
  });
  blocks = bindUserUuid(blocks, (raw as { user_message_uuid?: string }).user_message_uuid);
  const isError = r.is_error === true || (typeof r.subtype === "string" && r.subtype !== "success");
  const last = blocks[blocks.length - 1];
  const interrupted = last?.kind === "notice" && last.variant === "interrupted";
  if (isError && !interrupted) {
    const errors = Array.isArray(r.errors) ? r.errors.filter(Boolean) : [];
    const message = errors.length ? errors.join("\n") : typeof r.result === "string" && r.result ? r.result : RESULT_ERRORS[r.subtype] ?? `Error: ${r.subtype}`;
    blocks = [...blocks, { kind: "error", id: `result-${now}-${blocks.length}`, title: "Error", message, ts: now }];
  }
  const status: ThreadStatus = s.status === "working" || s.status === "awaiting_user" ? "idle" : s.status;
  return { ...s, blocks, streams: {}, lastResult: raw, status };
}

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: "Reached the maximum number of turns.",
  error_max_budget_usd: "Reached the maximum budget for this session.",
  error_during_execution: "An error occurred while running.",
  error_max_structured_output_retries: "Could not produce valid structured output.",
};

function onSystem(s: ThreadRuntime, raw: RawMessage, now: number, seeding: boolean): ThreadRuntime {
  const subtype = String(raw.subtype ?? "");
  const ts = tsOf(raw) ?? (seeding ? null : now);
  switch (subtype) {
    case "init":
      return {
        ...s,
        systemInit: raw,
        model: typeof raw.model === "string" ? raw.model : s.model,
        permissionMode: typeof raw.permissionMode === "string" ? (raw.permissionMode as PermissionMode) : s.permissionMode,
      };
    case "compact_boundary": {
      const meta = (raw.compact_metadata ?? {}) as { trigger?: string };
      const text = meta.trigger === "manual" ? "Conversation compacted" : "Conversation compacted automatically";
      return { ...s, blocks: [...s.blocks, { kind: "notice", id: `compact-${String(raw.uuid ?? now)}`, variant: "compact", text, ts }] };
    }
    case "informational":
    case "local_command_output": {
      const text = String(raw.content ?? "");
      if (!text.trim()) return s;
      const variant = raw.level === "warning" ? "warning" : "info";
      return { ...s, blocks: [...s.blocks, { kind: "notice", id: `info-${String(raw.uuid ?? now)}-${s.blocks.length}`, variant, text, ts }] };
    }
    case "model_refusal_no_fallback":
      return {
        ...s,
        blocks: [...s.blocks, { kind: "error", id: `refusal-${String(raw.uuid ?? now)}`, title: "Request refused", message: String(raw.content ?? ""), ts }],
      };
    case "task_progress":
    case "task_notification": {
      const toolId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : null;
      const path = toolId ? findTool(s.blocks, toolId) : null;
      if (!path) return s;
      const usage = (raw.usage ?? {}) as { total_tokens?: number; tool_uses?: number; duration_ms?: number };
      return {
        ...s,
        blocks: updateAt(s.blocks, path, (b) => {
          const t = b as ToolBlock;
          const prev = t.progress;
          const progress: TaskProgress = {
            description: typeof raw.description === "string" ? raw.description : prev?.description ?? null,
            lastToolName: typeof raw.last_tool_name === "string" ? raw.last_tool_name : prev?.lastToolName ?? null,
            toolUses: usage.tool_uses ?? prev?.toolUses ?? null,
            totalTokens: usage.total_tokens ?? prev?.totalTokens ?? null,
            durationMs: usage.duration_ms ?? prev?.durationMs ?? null,
            summary: typeof raw.summary === "string" ? raw.summary : prev?.summary ?? null,
            state: subtype === "task_notification" ? ((raw.status as TaskProgress["state"]) ?? "completed") : "running",
          };
          return { ...t, progress };
        }),
      };
    }
    default:
      if (!SILENT_SYSTEM.has(subtype)) logUnknown(`system/${subtype}`, raw);
      return s;
  }
}

function onToolProgress(s: ThreadRuntime, raw: RawMessage): ThreadRuntime {
  const path = typeof raw.tool_use_id === "string" ? findTool(s.blocks, raw.tool_use_id) : null;
  if (!path || typeof raw.elapsed_time_seconds !== "number") return s;
  const elapsed = raw.elapsed_time_seconds;
  return { ...s, blocks: updateAt(s.blocks, path, (b) => ({ ...(b as ToolBlock), elapsedSeconds: elapsed })) };
}

function onMessage(s: ThreadRuntime, raw: RawMessage, now: number, seeding = false): ThreadRuntime {
  switch (raw.type) {
    case "assistant":
      return onAssistant(s, raw, now, seeding);
    case "user":
      return onUser(s, raw, now, seeding);
    case "stream_event":
      return onStreamEvent(s, raw, now);
    case "result":
      return onResult(s, raw, now);
    case "system":
      return onSystem(s, raw, now, seeding);
    case "tool_progress":
      return onToolProgress(s, raw);
    default:
      if (!SILENT_TYPES.has(raw.type)) logUnknown(String(raw.type), raw);
      return s;
  }
}

// ---------- the reducer ----------

const withSeq = (s: ThreadRuntime, seq: number) => (seq > s.lastSeq ? { ...s, lastSeq: seq } : s);

export function reduce(s: ThreadRuntime, a: ThreadAction, now: number): ThreadRuntime {
  switch (a.kind) {
    case "message": {
      // An ignored message (keep-alive, hook chatter, a stray delta) leaves the runtime as is, so
      // subscribers don't re-render for it; `lastSeq` only tracks messages that changed state.
      const next = onMessage(s, a.raw, now);
      return next === s ? s : withSeq(next, a.seq);
    }
    case "initialized": {
      const mode = a.response.current_permission_mode;
      return withSeq({ ...s, init: a.response, permissionMode: typeof mode === "string" ? (mode as PermissionMode) : s.permissionMode }, a.seq);
    }
    case "session_bound":
      return withSeq({ ...s, sessionId: a.session_id }, a.seq);
    case "status": {
      const done = a.status === "idle" || a.status === "crashed" || a.status === "errored" || a.status === "stopped";
      return withSeq(
        {
          ...s,
          status: a.status,
          detail: a.detail,
          stderrTail: a.stderr_tail ?? s.stderrTail,
          reconnecting: a.reconnecting,
          retrying: done ? false : s.retrying,
          // A turn that ended by crash/stop leaves nothing streaming.
          streams: done ? {} : s.streams,
        },
        a.seq,
      );
    }
    case "permission_request":
      return withSeq(
        {
          ...s,
          pendingPermissions: [
            ...s.pendingPermissions.filter((p) => p.requestId !== a.request_id),
            { requestId: a.request_id, request: a.request, diff: a.diff, seq: a.seq },
          ],
        },
        a.seq,
      );
    case "permission_resolved":
      return withSeq({ ...s, pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== a.request_id) }, a.seq);
    case "stderr": {
      const tail = (s.stderrTail + a.text + (a.text.endsWith("\n") ? "" : "\n")).slice(-STDERR_TAIL_MAX);
      return withSeq({ ...s, stderrTail: tail }, a.seq);
    }
    case "protocol_error":
      return withSeq(
        {
          ...s,
          blocks: [
            ...s.blocks,
            { kind: "error", id: `proto-${a.seq}`, title: "Unreadable output from claude", message: a.line.length > 2000 ? `${a.line.slice(0, 2000)}…` : a.line, ts: now },
          ],
        },
        a.seq,
      );

    // ---- local actions ----
    case "local_user": {
      const { text, images } = flattenText(a.content);
      return {
        ...s,
        blocks: [...s.blocks, { kind: "user", id: a.id, uuid: null, text, images, ts: a.ts }],
        status: s.status === "idle" ? "working" : s.status,
      };
    }
    case "seed":
      return seedRuntime(s, a.lines, now, true);
    case "seed_state":
      return { ...s, seed: a.seed };
    case "local_notice":
      return { ...s, blocks: [...s.blocks, { kind: "notice", id: `local-${now}-${s.blocks.length}`, variant: a.variant, text: a.text, ts: now }] };
    case "local_status":
      return { ...s, status: a.status, detail: a.detail ?? s.detail };
    case "retrying":
      return { ...s, retrying: true };
    case "permission_answered":
      return { ...s, pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== a.requestId) };
    case "permission_refreshed":
      return { ...s, pendingPermissions: s.pendingPermissions.map((p) => (p.requestId === a.requestId ? { ...p, diff: a.diff } : p)) };
    case "queue_add":
      return { ...s, queue: [...s.queue, a.item] };
    case "queue_remove":
      return { ...s, queue: s.queue.filter((q) => q.id !== a.id) };
    case "context_usage":
      return { ...s, contextUsage: a.usage };
  }
}

function seedRuntime(s: ThreadRuntime, lines: Record<string, unknown>[], now: number, useDraft: boolean): ThreadRuntime {
  let next: ThreadRuntime = { ...s, blocks: [] };
  const prevDraft = draft;
  draft = useDraft ? { toolPaths: new Map(), textCounts: new Map() } : null;
  try {
    for (const line of lines) {
      const type = line.type;
      if (type !== "user" && type !== "assistant") continue;
      if (line.isSidechain === true) continue;
      next = onMessage(next, { ...line, parent_tool_use_id: null } as unknown as RawMessage, now, true);
    }
  } finally {
    draft = prevDraft;
  }
  // Seeded history is complete: nothing from it is still running.
  const blocks = mapAll(next.blocks, (b) => (b.kind === "tool" && b.status === "running" ? { ...b, status: "done" as const } : b));
  return { ...next, blocks: [...blocks, ...s.blocks], streams: {}, seed: "done" };
}

/** Test-only: the seed reducer without the mutable draft (the original copy-per-line path). */
export function __seedWithoutDraftForTests(s: ThreadRuntime, lines: Record<string, unknown>[], now: number): ThreadRuntime {
  return seedRuntime(s, lines, now, false);
}

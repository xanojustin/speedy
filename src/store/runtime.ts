// U8: the bridge between the Rust session actor (ClaudeEvent channel) and the thread store.
// Processes start lazily on first send (KTD9); every thread's events are ingested regardless of
// which thread is visible (KTD2).
import {
  claudeControl,
  claudeInterrupt,
  claudeRespondPermission,
  claudeRetry,
  claudeSendUser,
  claudeStart,
  sessionLoad,
} from "../ipc/commands";
import type { ClaudeEvent, PermissionOutcome, PermissionResult, StartOptions, ThreadStatus } from "../ipc/types";
import { findThread, newId, useAppStore } from "./appStore";
import { __resetThreadEventsForTests, getRuntime, queueThreadEvent, useThreadStore, type ThreadAction } from "./threadStore";

const started = new Map<string, Promise<void>>();
/** Threads with a user message written and no `result` yet; guards against double-sending the queue. */
const inFlight = new Set<string>();

const dispatch = (threadId: string, action: ThreadAction) => useThreadStore.getState().dispatch(threadId, action);

export function __resetRuntimeForTests() {
  started.clear();
  inFlight.clear();
  __resetThreadEventsForTests();
}

function handleEvent(threadId: string, ev: ClaudeEvent) {
  // Applied with the next frame's batch; the reads below (`getRuntime`) apply it first.
  queueThreadEvent(threadId, ev);
  switch (ev.kind) {
    case "session_bound":
      useAppStore.getState().updateThread(threadId, { sessionId: ev.session_id });
      break;
    case "message":
      if (ev.raw.type === "result") {
        inFlight.delete(threadId);
        flushQueue(threadId);
      }
      break;
    case "status":
      if (ev.status === "idle") flushQueue(threadId);
      else if (ev.status === "crashed" || ev.status === "errored" || ev.status === "stopped") inFlight.delete(threadId);
      break;
  }
}

/** Where a rewind fork starts: resume `resumeSessionId` truncated at `resumeSessionAt`, as a new session (U11). */
export type ForkFrom = Required<Pick<StartOptions, "resumeSessionId" | "resumeSessionAt" | "forkSession">>;

/**
 * Drops the cached start so the next `ensureStarted` calls `claude_start` again: that is the only
 * way the Rust actor leaves Stopped (archive, project removal, then restore or resume).
 */
export function forgetStarted(threadId: string) {
  started.delete(threadId);
}

/**
 * Spawns (or rebinds to) the thread's claude process once per run. Idempotent until the thread
 * stops (see `forgetStarted`). `fork` applies to the first spawn only.
 */
export function ensureStarted(threadId: string, fork?: ForkFrom): Promise<void> {
  const existing = started.get(threadId);
  if (existing) return existing;
  const found = findThread(useAppStore.getState(), threadId);
  if (!found) return Promise.reject(new Error(`unknown thread ${threadId}`));
  const { project, thread } = found;
  // Only this run's own stop or failure may clear its cache entry, not a later run's.
  const isCurrent = () => started.get(threadId) === p;
  const p: Promise<void> = claudeStart(
    threadId,
    { cwd: project.path, resumeSessionId: thread.sessionId, model: thread.model, permissionMode: thread.permissionMode, ...fork },
    (ev) => {
      if (ev.kind === "status" && ev.status === "stopped" && isCurrent()) started.delete(threadId);
      handleEvent(threadId, ev);
    },
  ).then(
    (status: ThreadStatus) => {
      // Channel events may already have moved the status on; only fill in the initial one
      // (or replace the previous run's "stopped" on a restart).
      const cur = getRuntime(threadId).status;
      if (cur === "not_started" || cur === "stopped") dispatch(threadId, { kind: "local_status", status });
      if (status === "idle") flushQueue(threadId);
    },
    (err: unknown) => {
      if (isCurrent()) started.delete(threadId);
      dispatch(threadId, { kind: "local_status", status: "errored", detail: String(err) });
      throw err;
    },
  );
  started.set(threadId, p);
  return p;
}

function textOf(content: unknown[]): string {
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .join(" ");
}

const TITLE_MAX = 60;
function maybeTitle(threadId: string, content: unknown[]) {
  const found = findThread(useAppStore.getState(), threadId);
  if (!found || found.thread.title !== "New thread") return;
  if (getRuntime(threadId).blocks.some((b) => b.kind === "user")) return;
  const text = textOf(content).replace(/\s+/g, " ").trim();
  if (!text) return;
  const title = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX).trimEnd()}…` : text;
  useAppStore.getState().updateThread(threadId, { title });
}

function send(threadId: string, content: unknown[]) {
  inFlight.add(threadId);
  dispatch(threadId, { kind: "local_user", id: newId(), content, ts: Date.now() });
  claudeSendUser(threadId, content).catch((err: unknown) => {
    inFlight.delete(threadId);
    // Undo the optimistic idle -> working so the thread doesn't show a spinner forever.
    if (getRuntime(threadId).status === "working") dispatch(threadId, { kind: "local_status", status: "idle" });
    dispatch(threadId, { kind: "local_notice", variant: "warning", text: `Message not sent: ${String(err)}` });
  });
}

function flushQueue(threadId: string) {
  if (inFlight.has(threadId)) return;
  const next = getRuntime(threadId).queue[0];
  if (!next) return;
  dispatch(threadId, { kind: "queue_remove", id: next.id });
  send(threadId, next.content);
}

/** Sends now when idle; otherwise queues and sends after the current turn's `result`. */
export async function sendUserMessage(threadId: string, content: unknown[]): Promise<void> {
  maybeTitle(threadId, content);
  try {
    await ensureStarted(threadId);
  } catch {
    // Start failed (status is errored); keep the message so a retry sends it.
  }
  const rt = getRuntime(threadId);
  if (rt.status === "idle" && !inFlight.has(threadId) && rt.queue.length === 0) send(threadId, content);
  else dispatch(threadId, { kind: "queue_add", item: { id: newId(), content } });
}

export function removeQueued(threadId: string, id: string) {
  dispatch(threadId, { kind: "queue_remove", id });
}

export function interruptThread(threadId: string): Promise<void> {
  return claudeInterrupt(threadId);
}

export async function retryThread(threadId: string): Promise<void> {
  dispatch(threadId, { kind: "retrying" });
  const status = await claudeRetry(threadId);
  const cur = getRuntime(threadId).status;
  if (cur === "crashed" || cur === "errored" || cur === "not_started") dispatch(threadId, { kind: "local_status", status });
}

/** Answers a can_use_tool request. On a stale diff nothing is sent and the card's diff is refreshed. */
export async function respondPermission(threadId: string, requestId: string, result: PermissionResult): Promise<PermissionOutcome> {
  const outcome = await claudeRespondPermission(threadId, requestId, result);
  if (outcome.sent) dispatch(threadId, { kind: "permission_answered", requestId });
  else dispatch(threadId, { kind: "permission_refreshed", requestId, diff: outcome.refreshedDiff });
  return outcome;
}

/** Sends a control request (set_model, set_permission_mode, get_context_usage, rewind_files, …). */
export async function controlRequest<T = unknown>(threadId: string, request: { subtype: string; [k: string]: unknown }, timeoutMs?: number): Promise<T> {
  const res = await claudeControl<T>(threadId, request, timeoutMs);
  if (request.subtype === "get_context_usage") dispatch(threadId, { kind: "context_usage", usage: res });
  return res;
}

/** Loads session JSONL lines (from `session_load`) into the transcript. */
export function seedTranscript(threadId: string, lines: Record<string, unknown>[]) {
  dispatch(threadId, { kind: "seed", lines });
}

/** On relaunch: seed a resumed thread's transcript from the CLI's session file, once. */
export async function loadSessionHistory(threadId: string): Promise<void> {
  const found = findThread(useAppStore.getState(), threadId);
  const rt = getRuntime(threadId);
  if (!found?.thread.sessionId || rt.seed !== "none" || rt.blocks.length > 0) return;
  dispatch(threadId, { kind: "seed_state", seed: "loading" });
  try {
    const lines = await sessionLoad(found.project.path, found.thread.sessionId);
    seedTranscript(threadId, lines);
  } catch (err) {
    dispatch(threadId, { kind: "seed_state", seed: "failed" });
    dispatch(threadId, { kind: "local_notice", variant: "warning", text: `Couldn't load earlier messages: ${String(err)}` });
  }
}

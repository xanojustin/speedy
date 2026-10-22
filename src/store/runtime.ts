// U8: the bridge between a thread's host events and the thread store. The host owns the
// thread's behavior (KTD6): it queues messages sent mid-turn, echoes each sent message as
// `user_sent`, titles new threads, binds the session and creates a requested worktree. This
// module subscribes each thread once, starts its process lazily on first send (KTD9), and
// ingests every subscribed thread's events whether or not it is visible (KTD2).
import {
  claudeControl,
  claudeInterrupt,
  claudeRespondPermission,
  claudeRetry,
  claudeSendUser,
  claudeStart,
  queueRemove,
  sessionLoad,
  threadSubscribe,
} from "../ipc/commands";
import type { ClaudeEvent, PermissionOutcome, PermissionResult, ThreadSnapshot, ThreadStatus } from "../ipc/types";
import { findThread, threadCwd, useAppStore } from "./appStore";
import { initialRuntime } from "./reducer";
import { __resetThreadEventsForTests, getRuntime, queueThreadEvent, useThreadStore, type ThreadAction } from "./threadStore";

const started = new Map<string, Promise<void>>();
/**
 * Each subscribed thread's subscription, settled once the host has opened it (or refused it).
 * A thread is subscribed once per run.
 */
const subscribed = new Map<string, Promise<void>>();
/** Threads that got their first snapshot; a later one means the client fell out of the replay window. */
const caughtUp = new Set<string>();

const dispatch = (threadId: string, action: ThreadAction) => useThreadStore.getState().dispatch(threadId, action);

export function __resetRuntimeForTests() {
  started.clear();
  subscribed.clear();
  caughtUp.clear();
  __resetThreadEventsForTests();
}

function handleEvent(threadId: string, ev: ClaudeEvent) {
  switch (ev.kind) {
    case "snapshot":
      void applySnapshot(threadId, ev.snapshot);
      return;
    case "subscribe_failed":
      dispatch(threadId, { kind: "local_notice", variant: "warning", text: `Couldn't follow this thread: ${ev.error}` });
      return;
  }
  // Applied with the next frame's batch.
  queueThreadEvent(threadId, ev);
}

/**
 * Catches up from the host's live state. The first snapshot of a run tops up whatever the
 * transcript already shows (history the chat pane seeds from the session file). A later one
 * means events were missed beyond replay, so the transcript is rebuilt from the session file.
 */
async function applySnapshot(threadId: string, snap: ThreadSnapshot) {
  if (caughtUp.has(threadId)) {
    useThreadStore.setState((s) => ({ threads: { ...s.threads, [threadId]: initialRuntime() } }));
    await loadSessionHistory(threadId);
  }
  caughtUp.add(threadId);
  for (const ev of snap.events) dispatch(threadId, ev);
  dispatch(threadId, { kind: "queue_changed", seq: snap.seq, queue: snap.queue });
}

/** Follows the thread's events (once per run); settles once the host has opened the subscription. */
function subscribe(threadId: string): Promise<void> {
  const existing = subscribed.get(threadId);
  if (existing) return existing;
  const p = threadSubscribe(threadId, (ev) => handleEvent(threadId, ev)).then(
    () => {},
    (err: unknown) => {
      subscribed.delete(threadId);
      dispatch(threadId, { kind: "local_notice", variant: "warning", text: `Couldn't follow this thread: ${String(err)}` });
    },
  );
  subscribed.set(threadId, p);
  return p;
}

/**
 * Drops the cached start so the next `ensureStarted` calls `claude_start` again: that is the only
 * way the host's actor leaves Stopped (archive, project removal, then restore or resume).
 */
export function forgetStarted(threadId: string) {
  started.delete(threadId);
}

/** Subscribes and spawns (or reuses) the thread's claude process once per run. Idempotent until it stops. */
export function ensureStarted(threadId: string): Promise<void> {
  const existing = started.get(threadId);
  if (existing) return existing;
  if (!findThread(useAppStore.getState(), threadId)) return Promise.reject(new Error(`unknown thread ${threadId}`));
  subscribe(threadId);
  // Only this run's own stop or failure may clear its cache entry, not a later run's.
  const isCurrent = () => started.get(threadId) === p;
  const p: Promise<void> = claudeStart(threadId).then(
    (status: ThreadStatus) => {
      // Events may already have moved the status on; only fill in the initial one.
      const cur = getRuntime(threadId).status;
      if (cur === "not_started" || cur === "stopped" || cur === "starting") dispatch(threadId, { kind: "local_status", status });
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

/** Sends now when idle; otherwise the host queues it and sends it after the current turn. */
export async function sendUserMessage(threadId: string, content: unknown[]): Promise<void> {
  // The host echoes the message as `user_sent` only to the subscribers it has when it goes out,
  // and a later snapshot doesn't carry it: the first send of a run waits for the subscription.
  await subscribe(threadId);
  try {
    await claudeSendUser(threadId, content);
  } catch (err) {
    dispatch(threadId, { kind: "local_notice", variant: "warning", text: `Message not sent: ${String(err)}` });
  }
  // The host started the process for this send; later calls reuse it.
  if (!started.has(threadId)) void ensureStarted(threadId).catch(() => {});
}

export function removeQueued(threadId: string, id: string) {
  void queueRemove(threadId, id).catch((err: unknown) => console.warn("removing a queued message failed", err));
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

/** Answers a can_use_tool request. On a stale diff nothing is sent; the `diff_refreshed` event updates the card. */
export async function respondPermission(threadId: string, requestId: string, result: PermissionResult): Promise<PermissionOutcome> {
  const outcome = await claudeRespondPermission(threadId, requestId, result);
  if (outcome.sent) dispatch(threadId, { kind: "permission_answered", requestId });
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
    const lines = await sessionLoad(found.project.hostKey, threadCwd(found.project, found.thread), found.thread.sessionId);
    seedTranscript(threadId, lines);
  } catch (err) {
    dispatch(threadId, { kind: "seed_state", seed: "failed" });
    dispatch(threadId, { kind: "local_notice", variant: "warning", text: `Couldn't load earlier messages: ${String(err)}` });
  }
}

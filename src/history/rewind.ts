// U11 rewind (R12, KTD4 checkpointing), mirroring the extension's per-message actions:
// - code: `rewind_files` restores the files checkpointed at a user message (dry run first to review);
// - conversation: forks the session at the message before it. The extension forks into a new
//   session; Speedy opens that fork in a new thread (one thread <-> one session), spawned with
//   `--resume <session> --resume-session-at <previous message> --fork-session`. The original thread
//   and its session stay as they were.
import { sessionLoad } from "../ipc/commands";
import { SESSION_TRUNCATED_TYPE } from "../ipc/types";
import { findThread, threadCwd, useAppStore } from "../store/appStore";
import { controlRequest, ensureStarted, seedTranscript } from "../store/runtime";

/** The CLI's `rewind_files` response. */
export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

type Line = Record<string, unknown>;

function threadOrThrow(threadId: string) {
  const found = findThread(useAppStore.getState(), threadId);
  if (!found) throw new Error(`unknown thread ${threadId}`);
  return found;
}

async function rewindFiles(threadId: string, userMessageId: string, dryRun: boolean): Promise<RewindFilesResult> {
  // Checkpoints live in the session; a thread reopened after relaunch needs its process first.
  await ensureStarted(threadId);
  return controlRequest<RewindFilesResult>(threadId, { subtype: "rewind_files", user_message_id: userMessageId, dry_run: dryRun });
}

/** Dry run: which files rewinding to this message would restore. Changes nothing. */
export const previewRewind = (threadId: string, userMessageId: string) => rewindFiles(threadId, userMessageId, true);

/** Restores the files checkpointed at this user message. */
export async function rewindCode(threadId: string, userMessageId: string): Promise<RewindFilesResult> {
  const res = await rewindFiles(threadId, userMessageId, false);
  if (!res.canRewind) throw new Error(res.error ?? "Failed to rewind code");
  return res;
}

const isMessage = (l: Line | undefined) =>
  !!l && (l.type === "user" || l.type === "assistant") && l.isSidechain !== true && l.isMeta !== true;

const parentOf = (l: Line) => (typeof l.parentUuid === "string" ? l.parentUuid : typeof l.logicalParentUuid === "string" ? l.logicalParentUuid : null);

/**
 * Where a fork before `userMessageId` resumes: the nearest earlier user/assistant message on its
 * parentUuid chain (`anchor`), and the chain's lines up to it in order (`history`, for seeding).
 * `anchor` is null when the message is the first in the conversation.
 */
export function forkPoint(lines: Line[], userMessageId: string): { anchor: string | null; history: Line[] } {
  // session_load returns only the newest part of a very large session, after a marker line.
  const truncated = lines[0]?.type === SESSION_TRUNCATED_TYPE;
  const byUuid = new Map<string, Line>();
  for (const l of lines) if (typeof l.uuid === "string") byUuid.set(l.uuid, l);
  const target = byUuid.get(userMessageId);
  if (!target) throw new Error(truncated ? TOO_OLD : `message ${userMessageId} not found in the session`);

  // Ancestors of the target, nearest first (guarding against a malformed cycle).
  const ancestors: Line[] = [];
  const seen = new Set<string>([userMessageId]);
  let last = target;
  for (let line = byUuid.get(parentOf(target) ?? ""); line && !seen.has(line.uuid as string); line = byUuid.get(parentOf(line) ?? "")) {
    seen.add(line.uuid as string);
    ancestors.push(line);
    last = line;
  }
  // In a truncated load, a chain that ends at an unloaded parent continues in the dropped lines.
  const cut = truncated && parentOf(last) !== null && !byUuid.has(parentOf(last) as string);
  const at = ancestors.findIndex(isMessage);
  if (at < 0) {
    // The message before this one wasn't loaded, so there is no known point to fork at.
    if (cut) throw new Error(TOO_OLD);
    return { anchor: null, history: [] };
  }
  const history = ancestors.slice(at).reverse();
  return { anchor: ancestors[at].uuid as string, history: cut ? [lines[0], ...history] : history };
}

const TOO_OLD = "This message is too far back in a large session to fork from here";

/**
 * Continues the conversation from just before `userMessageId` in a new, selected thread.
 * Returns the new thread's id.
 */
export async function forkConversation(threadId: string, userMessageId: string): Promise<string> {
  return (await prepareFork(threadId, userMessageId))();
}

/**
 * Finds where a fork before `userMessageId` resumes, failing now if it can't, and returns the
 * step that creates the fork. Lets "fork and rewind" check the fork before changing any code.
 */
export async function prepareFork(threadId: string, userMessageId: string): Promise<() => string> {
  const { project, thread } = threadOrThrow(threadId);
  if (!thread.sessionId) throw new Error("This conversation has no session to fork yet");
  const sessionId = thread.sessionId;
  const lines = await sessionLoad(project.hostKey, threadCwd(project, thread), sessionId);
  const { anchor, history } = forkPoint(lines, userMessageId);
  return () => {
    const app = useAppStore.getState();
    // The fork shares the thread's worktree: its session file lives under that folder.
    const worktree = thread.worktree ?? null;
    if (!anchor) return app.createThread(project.id, { worktree }); // Nothing before the first message: a fresh conversation.

    // The host spawns the fork with --resume/--resume-session-at/--fork-session until its own session binds.
    const forkId = app.createThread(project.id, { title: thread.title, worktree, fork: { resumeSessionId: sessionId, resumeSessionAt: anchor } });
    seedTranscript(forkId, history);
    // Start errors show on the thread.
    void ensureStarted(forkId).catch(() => {});
    return forkId;
  };
}

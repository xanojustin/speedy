// U11 rewind (R12, KTD4 checkpointing), mirroring the extension's per-message actions:
// - code: `rewind_files` restores the files checkpointed at a user message (dry run first to review);
// - conversation: forks the session at the message before it. The extension forks into a new
//   session; Speedy opens that fork in a new thread (one thread <-> one session), spawned with
//   `--resume <session> --resume-session-at <previous message> --fork-session`. The original thread
//   and its session stay as they were.
import { sessionLoad } from "../ipc/commands";
import { findThread, useAppStore } from "../store/appStore";
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
  const byUuid = new Map<string, Line>();
  for (const l of lines) if (typeof l.uuid === "string") byUuid.set(l.uuid, l);
  const target = byUuid.get(userMessageId);
  if (!target) throw new Error(`message ${userMessageId} not found in the session`);

  // Ancestors of the target, nearest first (guarding against a malformed cycle).
  const ancestors: Line[] = [];
  const seen = new Set<string>([userMessageId]);
  for (let line = byUuid.get(parentOf(target) ?? ""); line && !seen.has(line.uuid as string); line = byUuid.get(parentOf(line) ?? "")) {
    seen.add(line.uuid as string);
    ancestors.push(line);
  }
  const at = ancestors.findIndex(isMessage);
  if (at < 0) return { anchor: null, history: [] };
  return { anchor: ancestors[at].uuid as string, history: ancestors.slice(at).reverse() };
}

/**
 * Continues the conversation from just before `userMessageId` in a new, selected thread.
 * Returns the new thread's id.
 */
export async function forkConversation(threadId: string, userMessageId: string): Promise<string> {
  const { project, thread } = threadOrThrow(threadId);
  if (!thread.sessionId) throw new Error("This conversation has no session to fork yet");
  const lines = await sessionLoad(project.path, thread.sessionId);
  const { anchor, history } = forkPoint(lines, userMessageId);
  const app = useAppStore.getState();
  if (!anchor) return app.createThread(project.id); // Nothing before the first message: a fresh conversation.

  const forkId = app.createThread(project.id, { title: thread.title });
  seedTranscript(forkId, history);
  // The fork's own session id binds on its first turn (session_bound); start errors show on the thread.
  void ensureStarted(forkId, { resumeSessionId: thread.sessionId, resumeSessionAt: anchor, forkSession: true }).catch(() => {});
  return forkId;
}

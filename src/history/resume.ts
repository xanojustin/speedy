// U11: resume and rename CLI sessions. One thread is bound to exactly one session; resuming never
// rebinds an existing thread, it selects the thread already bound or opens a new one (KTD6).
import { ask } from "@tauri-apps/plugin-dialog";
import { sessionLoad, sessionRenameOffline } from "../ipc/commands";
import { isLiveStatus, type SessionMeta, type Thread } from "../ipc/types";
import { threadCwd, useAppStore } from "../store/appStore";
import { controlRequest, ensureStarted, seedTranscript } from "../store/runtime";
import { getRuntime } from "../store/threadStore";

/** A session file written this recently is probably live in VS Code or a terminal `claude`. */
const LIVE_ELSEWHERE_MS = 60_000;

const hasLiveActor = (threadId: string) => isLiveStatus(getRuntime(threadId).status);

function projectOf(projectId: string) {
  const project = useAppStore.getState().projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  return project;
}

/** The thread bound to a session, preferring a non-archived one. */
function boundThread(projectId: string, sessionId: string): Thread | undefined {
  const bound = projectOf(projectId).threads.filter((t) => t.sessionId === sessionId);
  return bound.find((t) => !t.archived) ?? bound[0];
}

type ResumeOutcome = "selected" | "restored" | "created" | "cancelled";

/**
 * Opens `session` in this project: selects (or restores) the thread already bound to it, otherwise
 * creates a thread for it, seeds the transcript from the JSONL, and starts it with `--resume`.
 * Rejects with session_load's error when the session file can't be read; nothing is created then.
 */
export async function resumeSession(projectId: string, session: SessionMeta, now = Date.now()): Promise<ResumeOutcome> {
  const app = useAppStore.getState();
  const project = projectOf(projectId);
  const bound = boundThread(projectId, session.sessionId);
  if (bound && !bound.archived) {
    app.selectThread(bound.id);
    return "selected";
  }
  if (bound) {
    app.restoreThread(bound.id);
    return "restored";
  }
  if (now - session.modifiedMs < LIVE_ELSEWHERE_MS) {
    const ok = await ask(
      "This conversation changed less than a minute ago, so it may still be open in VS Code or a terminal. " +
        "Resuming it here means two Claude processes write to the same history.",
      { title: "Resume a conversation that may be in use?", kind: "warning", okLabel: "Resume anyway", cancelLabel: "Cancel" },
    );
    if (!ok) return "cancelled";
  }
  const lines = await sessionLoad(project.path, session.sessionId);
  const threadId = useAppStore.getState().createThread(projectId, { sessionId: session.sessionId, title: session.title });
  seedTranscript(threadId, lines);
  // Start failures surface as the thread's errored status (ErrorCard), not here.
  void ensureStarted(threadId).catch(() => {});
  return "created";
}

/**
 * Renames a session: through the bound thread's live actor when there is one (`rename_session`),
 * otherwise by appending the CLI's own `custom-title` entry. The bound thread's title follows.
 */
export async function renameSession(projectId: string, sessionId: string, title: string): Promise<void> {
  const project = projectOf(projectId);
  const bound = boundThread(projectId, sessionId);
  if (bound && hasLiveActor(bound.id)) await controlRequest(bound.id, { subtype: "rename_session", title });
  else await sessionRenameOffline(bound ? threadCwd(project, bound) : project.path, sessionId, title);
  if (bound) useAppStore.getState().updateThread(bound.id, { title });
}

/** The extension's compact relative time: now, 5m, 3h, 2d, 1mo, 1y. */
export function relativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 365) return `${Math.floor(days / 365)}y`;
  if (days >= 30) return `${Math.floor(days / 30)}mo`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "now";
}

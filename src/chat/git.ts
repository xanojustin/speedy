import { useEffect, useState } from "react";
import { explorerGitBranch } from "../ipc/commands";
import { findThread, threadCwd, useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";

const BRANCH_POLL_MS = 4000;

/** The checked-out branch at `root` (null outside a repository), kept current while agents and terminals switch it. */
export function useGitBranch(root: string | undefined) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!root) return;
    let live = true;
    const refresh = () =>
      void explorerGitBranch(root)
        .then((b) => live && setBranch(typeof b === "string" ? b : null))
        .catch(() => live && setBranch(null));
    refresh();
    const id = window.setInterval(refresh, BRANCH_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [root]);
  return branch;
}

/**
 * Whether the thread can still opt into its own worktree: it's in a git repository and hasn't
 * started. A failed start with no messages yet ("errored") can still change its mind.
 */
export function useWorktreeChoosable(threadId: string): boolean {
  const thread = useAppStore((s) => findThread(s, threadId)?.thread);
  const cwd = useAppStore((s) => {
    const found = findThread(s, threadId);
    return found ? threadCwd(found.project, found.thread) : undefined;
  });
  const branch = useGitBranch(cwd);
  const fresh = useThreadStore((s) => {
    const rt = s.threads[threadId];
    return !rt || (rt.blocks.length === 0 && (rt.status === "not_started" || rt.status === "errored"));
  });
  return branch !== null && fresh && !thread?.sessionId && !thread?.worktree;
}

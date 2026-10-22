// Runs a pinned command in a thread: a prompt goes to the thread's Claude (or into its composer),
// a shell command runs in a new terminal tab. Both start in the thread's folder (its worktree when
// it has one): Claude already works there, and a thread's terminals open there.
import { newTerminal } from "../app/shortcuts";
import { PREFILL_COMPOSER_EVENT, type PrefillComposerDetail } from "../composer/focusEvent";
import type { PinnedCommand, PinnedPlacement } from "../ipc/types";
import { sendUserMessage } from "../store/runtime";
import { queueTerminalInput } from "../terminal/registry";
import { useTerminalTabs } from "../terminal/tabs";

// Commands run exactly as written: a leading space is meaningful (a shell keeps such a command out
// of its history). Only a blank command is skipped.
export function runPinnedCommand(threadId: string, cmd: PinnedCommand): void {
  const text = cmd.command;
  if (!text.trim()) return;
  if (cmd.kind === "terminal") {
    const id = newTerminal(threadId);
    // Named after the command until the shell sets its own title.
    useTerminalTabs.getState().setTitle(id, cmd.name);
    // Enter is pressed here, so a trailing line break would run an empty line after it.
    queueTerminalInput(id, `${text.replace(/[\r\n]+$/, "")}\r`);
    return;
  }
  if (cmd.autoSubmit) {
    void sendUserMessage(threadId, [{ type: "text", text }]);
    return;
  }
  window.dispatchEvent(
    new CustomEvent<PrefillComposerDetail>(PREFILL_COMPOSER_EVENT, { detail: { threadId, text, placement: cmd.placement } }),
  );
}

/** How the command runs, for the settings table and the button's tooltip. */
export function pinnedActionLabel(cmd: Pick<PinnedCommand, "kind" | "autoSubmit" | "placement">): string {
  if (cmd.kind === "terminal") return "Terminal";
  if (cmd.autoSubmit) return "Send prompt";
  return PLACEMENT_ACTION[cmd.placement] ?? "Fill prompt";
}

const PLACEMENT_ACTION: Record<PinnedPlacement, string> = { before: "Insert before", after: "Insert after", replace: "Replace text" };

export const pinnedIcon = (cmd: Pick<PinnedCommand, "kind" | "autoSubmit">) =>
  cmd.kind === "terminal" ? "terminal" : cmd.autoSubmit ? "send" : "edit";

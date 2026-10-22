// Runs a pinned command in a thread: a prompt goes to the thread's Claude (or into its composer),
// a shell command runs in a new terminal tab. Both start in the thread's folder (its worktree when
// it has one): Claude already works there, and a thread's terminals open there.
import { newTerminal } from "../app/shortcuts";
import { PREFILL_COMPOSER_EVENT, type PrefillComposerDetail } from "../composer/focusEvent";
import type { PinnedCommand } from "../ipc/types";
import { sendUserMessage } from "../store/runtime";
import { queueTerminalInput } from "../terminal/registry";
import { useTerminalTabs } from "../terminal/tabs";

export function runPinnedCommand(threadId: string, cmd: PinnedCommand): void {
  const text = cmd.command.trim();
  if (!text) return;
  if (cmd.kind === "terminal") {
    const id = newTerminal(threadId);
    // Named after the command until the shell sets its own title.
    useTerminalTabs.getState().setTitle(id, cmd.name);
    queueTerminalInput(id, `${text}\r`);
    return;
  }
  if (cmd.autoSubmit) {
    void sendUserMessage(threadId, [{ type: "text", text }]);
    return;
  }
  window.dispatchEvent(new CustomEvent<PrefillComposerDetail>(PREFILL_COMPOSER_EVENT, { detail: { threadId, text } }));
}

/** How the command runs, for the settings table and the button's tooltip. */
export function pinnedActionLabel(cmd: Pick<PinnedCommand, "kind" | "autoSubmit">): string {
  if (cmd.kind === "terminal") return "Terminal";
  return cmd.autoSubmit ? "Send prompt" : "Fill prompt";
}

export const pinnedIcon = (cmd: Pick<PinnedCommand, "kind" | "autoSubmit">) =>
  cmd.kind === "terminal" ? "terminal" : cmd.autoSubmit ? "send" : "edit";

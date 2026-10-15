// Per-thread status glyph (R5): one codicon and one accessible label per ThreadStatus.
import type { ThreadStatus } from "../ipc/types";

const GLYPHS: Record<ThreadStatus, { icon: string; label: string; spin?: boolean }> = {
  not_started: { icon: "circle-small", label: "Not started" },
  starting: { icon: "ellipsis", label: "Starting" },
  idle: { icon: "circle-small-filled", label: "Idle" },
  working: { icon: "loading", label: "Working", spin: true },
  awaiting_user: { icon: "bell-dot", label: "Waiting for your input" },
  crashed: { icon: "debug-disconnect", label: "Crashed" },
  errored: { icon: "error", label: "Error" },
  stopped: { icon: "debug-stop", label: "Stopped" },
};

/** A finished thread the user hasn't looked at yet. */
const UNREAD = { icon: "circle-filled", label: "Finished, unread" };

export function StatusGlyph({ status, unread = false }: { status: ThreadStatus; unread?: boolean }) {
  // A busy or failing thread keeps its own glyph; unread only replaces the quiet states.
  const showUnread = unread && (status === "idle" || status === "stopped" || status === "not_started");
  const g = showUnread ? UNREAD : GLYPHS[status];
  const classes = ["status-glyph", "codicon", `codicon-${g.icon}`, `status-${showUnread ? "unread" : status}`];
  if (showUnread) classes.push("unread");
  if ("spin" in g && g.spin) classes.push("codicon-modifier-spin");
  return <span role="img" aria-label={g.label} title={g.label} className={classes.join(" ")} />;
}

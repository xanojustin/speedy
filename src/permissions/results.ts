// U10: the PermissionResult shapes each card choice sends, matching the Claude Code extension
// (2.1.299) so the CLI and the model see the same answers they would from VS Code.
import type { PermissionDestination, PermissionResult, PermissionUpdate } from "../ipc/types";

/** The CLI's standard rejection text (the model reads it). */
export const DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
export const REJECT_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ";
export const KEEP_PLANNING_MESSAGE = "User chose to stay in plan mode and continue planning";

export function allowOnce(input: Record<string, unknown>): PermissionResult {
  return { behavior: "allow", updatedInput: input };
}

export function allowWith(input: Record<string, unknown>, updatedPermissions: PermissionUpdate[]): PermissionResult {
  return { behavior: "allow", updatedInput: input, updatedPermissions };
}

/**
 * Deny like the extension: typed feedback is appended to the rejection text and lets the turn
 * continue; no feedback interrupts the turn so Claude waits for the user.
 */
export function deny(feedback: string, opts: { plan?: boolean } = {}): PermissionResult {
  const text = feedback.trim();
  if (text) return { behavior: "deny", message: `${REJECT_WITH_REASON_PREFIX} ${text}`, interrupt: false };
  return { behavior: "deny", message: opts.plan ? KEEP_PLANNING_MESSAGE : DENY_MESSAGE, interrupt: true };
}

/**
 * The updates the always-allow choice grants: exactly the kind its label names (rules, else
 * directories, else a mode switch), never extra grants bundled alongside. The CLI often suggests
 * `addRules` together with `addDirectories` and `setMode acceptEdits`; sending all of them would
 * silently switch the session to auto-accepting edits. A switch to bypassPermissions is dropped
 * unless the user opted in to it (claudeCode setting).
 */
export function filterSuggestions(suggestions: PermissionUpdate[] | undefined, allowBypass: boolean): PermissionUpdate[] {
  const allowed = (suggestions ?? []).filter(
    (s) => allowBypass || !(s.type === "setMode" && s.mode === "bypassPermissions"),
  );
  for (const kind of ["addRules", "addDirectories", "setMode"] as const) {
    const group = allowed.filter((s) => s.type === kind);
    if (group.length) return group;
  }
  return [];
}

export const DESTINATION_LABEL: Record<PermissionDestination, string> = {
  localSettings: "this project (local, .claude/settings.local.json)",
  projectSettings: "this project (shared, .claude/settings.json)",
  userSettings: "all projects (~/.claude/settings.json)",
  session: "this session only",
  cliArg: "startup options",
};

/** Distinct destinations of the suggestions, in the order they first appear. */
export function destinationsOf(suggestions: PermissionUpdate[]): PermissionDestination[] {
  return [...new Set(suggestions.map((s) => s.destination))];
}

/** Project-scoped rules also auto-approve for other threads in the folder and for VS Code (KTD5). */
export const isProjectDestination = (d: PermissionDestination) => d === "localSettings" || d === "projectSettings";

function ruleLabel(rule: { toolName: string; ruleContent?: string }): string {
  const content = rule.ruleContent;
  if (!content) return rule.toolName;
  const prefix = content.match(/^(.+):\*$/)?.[1];
  if (prefix) return prefix;
  const chars = [...content];
  return chars.length > 20 ? `${chars.slice(0, 17).join("")}…` : content;
}

/** What the always-allow choice grants, e.g. "allow npm test" / "allow access to src/". */
export function grantSummary(suggestions: PermissionUpdate[]): string {
  const rules: string[] = [];
  const dirs: string[] = [];
  let mode: string | null = null;
  for (const s of suggestions) {
    if (s.type === "addRules") rules.push(...s.rules.map(ruleLabel));
    else if (s.type === "addDirectories") dirs.push(...s.directories.map((d) => `${d.split(/[/\\]/).pop() || d}/`));
    else if (s.type === "setMode") mode = s.mode;
  }
  if (rules.length === 1) return `Yes, allow ${rules[0]}`;
  if (rules.length === 2) return `Yes, allow ${rules[0]} and ${rules[1]}`;
  if (rules.length > 2) return `Yes, allow ${rules[0]} and ${rules.length - 1} more`;
  if (dirs.length === 1) return `Yes, allow access to ${dirs[0]}`;
  if (dirs.length > 1) return `Yes, allow access to ${dirs.length} directories`;
  if (mode === "acceptEdits") return "Yes, allow all edits";
  if (mode === "default") return "Yes, return to normal mode";
  return "Yes, and don't ask again";
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export const OTHER = "Other";

/**
 * AskUserQuestion answers as the CLI expects them: `{[question text]: answer}`, multi-select
 * labels comma-separated in pick order, and the typed text in place of "Other".
 */
export function buildAnswers(
  questions: Question[],
  picked: Record<string, string[]>,
  otherText: Record<string, string>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const typed = (otherText[q.question] ?? "").trim();
    const parts = (picked[q.question] ?? []).flatMap((label) => (label === OTHER ? (typed ? [typed] : []) : [label]));
    if (parts.length) answers[q.question] = parts.join(", ");
  }
  return answers;
}

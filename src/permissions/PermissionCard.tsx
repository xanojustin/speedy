// U10: inline card for one pending can_use_tool request. Dispatches to the plan approval and
// question cards; everything else gets the extension's generic prompt (allow once / always
// allow / deny with feedback), with a diff for file edits.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useComposerSettings } from "../composer/settings";
import { useThreadRuntime, type PendingPermission } from "../store/threadStore";
import { ChoiceCard, useResponder, type Choice } from "./ChoiceCard";
import { DiffView, type FileVerdict } from "./DiffView";
import { PlanApproval } from "./PlanApproval";
import { QuestionCard } from "./QuestionCard";
import {
  allowOnce,
  allowWith,
  deny,
  DESTINATION_LABEL,
  destinationsOf,
  filterSuggestions,
  grantSummary,
  isProjectDestination,
} from "./results";
import "./permissions.css";

export function PermissionCard({ threadId, requestId }: { threadId: string; requestId: string }) {
  const pending = useThreadRuntime(threadId).pendingPermissions.find((p) => p.requestId === requestId);
  if (!pending) return null;
  const tool = pending.request.tool_name;
  return (
    // `permission-card` + data attributes are how ChatPane (and its tests) find cards.
    <div className="permission-card" data-thread={threadId} data-request={requestId}>
      {tool === "ExitPlanMode" ? (
        <PlanApproval threadId={threadId} pending={pending} />
      ) : tool === "AskUserQuestion" ? (
        <QuestionCard threadId={threadId} pending={pending} />
      ) : (
        <GenericPrompt threadId={threadId} pending={pending} />
      )}
    </div>
  );
}

/** `claudeCode.allowDangerouslySkipPermissions` (off until loaded). */
function useAllowBypass(): boolean {
  return useComposerSettings()?.allowDangerouslySkipPermissions ?? false;
}

const basename = (p: string) => p.split(/[/\\]/).pop() || p;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function Header({ children }: { children: ReactNode }) {
  return <div className="perm-header">{children}</div>;
}

function Path({ children }: { children: ReactNode }) {
  return <span className="perm-path">{children}</span>;
}

function headerFor(p: PendingPermission): ReactNode {
  const { tool_name: tool, input, display_name } = p.request;
  const file = str(input.file_path) || str(input.notebook_path);
  switch (tool) {
    case "Bash":
      return "Allow this bash command?";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return (
        <>
          Make this edit to <Path>{basename(file)}</Path>?
        </>
      );
    case "Write":
      return (
        <>
          Allow write to <Path>{basename(file)}</Path>?
        </>
      );
    case "Read":
      return (
        <>
          Allow reading from <Path>{basename(file)}</Path>?
        </>
      );
    case "WebFetch":
      return "Allow fetching this url?";
    case "WebSearch":
      return "Allow searching for this query?";
    default:
      return (
        <>
          Do you want to proceed with <strong>{display_name || tool}</strong>?
        </>
      );
  }
}

function Body({ p }: { p: PendingPermission }) {
  const { tool_name: tool, input, title, description, decision_reason, blocked_path } = p.request;
  const lines: ReactNode[] = [];
  if (tool === "Bash") {
    lines.push(
      <pre key="cmd" className="perm-input perm-command">
        {str(input.command)}
      </pre>,
    );
    if (str(input.description)) lines.push(<div key="desc" className="perm-description">{str(input.description)}</div>);
  } else {
    const subject = str(input.url) || str(input.query);
    if (subject) lines.push(<div key="subject" className="perm-input">{subject}</div>);
    else if (!p.diff && str(input.file_path)) lines.push(<div key="file" className="perm-input">{str(input.file_path)}</div>);
    const text = title || description;
    if (text) lines.push(<div key="desc" className="perm-description">{text}</div>);
  }
  if (decision_reason) lines.push(<div key="reason" className="perm-reason">{decision_reason}</div>);
  if (blocked_path)
    lines.push(
      <div key="blocked" className="perm-reason">
        Outside the allowed directories: <Path>{blocked_path}</Path>
      </div>,
    );
  const known = tool === "Bash" || tool === "Edit" || tool === "MultiEdit" || tool === "Write" || tool === "Read" || tool === "WebFetch" || tool === "WebSearch";
  if (!known && Object.keys(input).length > 0)
    lines.push(
      <details key="details" className="perm-details">
        <summary>Details</summary>
        <pre className="perm-json">{JSON.stringify(input, null, 2)}</pre>
      </details>,
    );
  return <>{lines}</>;
}

function GenericPrompt({ threadId, pending }: { threadId: string; pending: PendingPermission }) {
  const { busy, error, stale, respond } = useResponder(threadId, pending.requestId);
  const allowBypass = useAllowBypass();
  const input = pending.request.input;
  const suggestions = useMemo(
    () => filterSuggestions(pending.request.permission_suggestions, allowBypass),
    [pending.request.permission_suggestions, allowBypass],
  );
  const diffs = pending.diff;
  const multi = (diffs?.length ?? 0) > 1;
  const [verdicts, setVerdicts] = useState<Record<string, FileVerdict>>({});
  // A refreshed diff must be reviewed again file by file.
  useEffect(() => setVerdicts({}), [diffs]);
  const allAccepted = !multi || diffs!.every((d) => verdicts[d.path] === "accepted");

  const onVerdict = (path: string, v: "accepted" | "rejected") => {
    if (v === "accepted") {
      setVerdicts((prev) => ({ ...prev, [path]: prev[path] === "accepted" ? undefined : "accepted" }));
      return;
    }
    // Rejecting any file rejects the whole tool call.
    setVerdicts((prev) => ({ ...prev, [path]: "rejected" }));
    void respond(deny(`Rejected the changes to ${path}`));
  };

  const choices: Choice[] = [{ label: "Yes", onSelect: () => void respond(allowOnce(input)), disabled: !allAccepted }];
  if (suggestions.length > 0) {
    const dests = destinationsOf(suggestions);
    choices.push({
      label: (
        <>
          {grantSummary(suggestions)} for <span className="perm-destination">{dests.map((d) => DESTINATION_LABEL[d]).join(", ")}</span>
        </>
      ),
      detail: dests.some(isProjectDestination) ? "The rule applies to every thread in this folder and VS Code too." : undefined,
      onSelect: () => void respond(allowWith(input, suggestions)),
      disabled: !allAccepted,
    });
  }

  return (
    <ChoiceCard
      busy={busy}
      error={error}
      notice={stale ? "The file changed since this diff was shown — review the updated diff." : undefined}
      choices={choices}
      deny={{ label: "No", onDeny: (feedback) => void respond(deny(feedback)) }}
    >
      <Header>{headerFor(pending)}</Header>
      <Body p={pending} />
      {diffs && diffs.length > 0 && <DiffView diffs={diffs} verdicts={verdicts} onVerdict={multi ? onVerdict : undefined} />}
    </ChoiceCard>
  );
}

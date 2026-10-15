// U10: ExitPlanMode approval. Shows the plan (safe Markdown) with the extension's choices:
// approve and auto-accept edits, approve with manual edit approval, or keep planning.
import { Markdown } from "../chat/markdown/Markdown";
import type { PendingPermission } from "../store/threadStore";
import { ChoiceCard, useResponder } from "./ChoiceCard";
import { allowWith, deny } from "./results";

export function PlanApproval({ threadId, pending }: { threadId: string; pending: PendingPermission }) {
  const { busy, error, respond } = useResponder(threadId, pending.requestId);
  const input = pending.request.input;
  const plan = typeof input.plan === "string" ? input.plan : "";
  const setMode = (mode: "acceptEdits" | "default") => [{ type: "setMode" as const, mode, destination: "session" as const }];

  return (
    <ChoiceCard
      className="perm-plan-card"
      busy={busy}
      error={error}
      choices={[
        { label: "Yes, and auto-accept", onSelect: () => void respond(allowWith(input, setMode("acceptEdits"))) },
        { label: "Yes, and manually approve edits", onSelect: () => void respond(allowWith(input, setMode("default"))) },
      ]}
      deny={{ label: "No, keep planning", onDeny: (feedback) => void respond(deny(feedback, { plan: true })) }}
    >
      <div className="perm-plan">
        <Markdown text={plan} />
      </div>
      <div className="perm-header">Accept this plan?</div>
    </ChoiceCard>
  );
}

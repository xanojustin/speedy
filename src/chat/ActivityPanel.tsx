// The optional activity panel above the composer: the agent's subagents, background work, and todo
// list (when the CLI offers todo tools), so none of it has to be dug out of the transcript. Toggled
// from the chat header; with nothing to show it shrinks to one quiet line.
import { useMemo, useState } from "react";
import { useAppStore } from "../store/appStore";
import { useThreadRuntime } from "../store/threadStore";
import { deriveActivity, isEmptyActivity, type ActivityAgent } from "./activity";
import { formatTokens, TodoList } from "./messages/ToolCard";

const STATE_DOT: Record<ActivityAgent["state"], string> = {
  running: "dot-progress",
  completed: "dot-success",
  failed: "dot-failure",
  stopped: "dot-stopped",
};

function agentMeta(a: ActivityAgent): string {
  return [
    a.toolUses != null ? `${a.toolUses} tool ${a.toolUses === 1 ? "use" : "uses"}` : null,
    a.totalTokens != null ? `${formatTokens(a.totalTokens)} tokens` : null,
    a.state === "running" ? a.lastToolName : a.state === "completed" ? null : a.state,
  ]
    .filter(Boolean)
    .join(" · ");
}

function AgentRow({ agent }: { agent: ActivityAgent }) {
  const meta = agentMeta(agent);
  return (
    <li className={`activity-agent ${STATE_DOT[agent.state]}`} data-state={agent.state}>
      <span className="activity-dot" aria-hidden="true" />
      <span className="activity-agent-main">
        <span className="activity-agent-label">{agent.label}</span>
        {agent.description && <span className="activity-agent-desc">{agent.description}</span>}
        {agent.background && <span className="activity-tag">background</span>}
        {agent.summary && agent.state === "running" && <span className="activity-agent-summary">{agent.summary}</span>}
      </span>
      {meta && <span className="activity-meta">{meta}</span>}
    </li>
  );
}

export function ActivityPanel({ threadId }: { threadId: string }) {
  const visible = useAppStore((s) => s.activityPanelVisible);
  const rt = useThreadRuntime(threadId);
  const activity = useMemo(() => deriveActivity(rt.blocks, rt.backgroundTasks), [rt.blocks, rt.backgroundTasks]);
  const [collapsed, setCollapsed] = useState(false);
  if (!visible) return null;
  if (isEmptyActivity(activity)) {
    return (
      <section className="activity-panel activity-empty" aria-label="Activity">
        <div className="activity-header">
          <span className="activity-title">Activity</span>
          <span className="activity-summary">Nothing running</span>
        </div>
      </section>
    );
  }

  const { todos, agents, others } = activity;
  const done = todos.filter((t) => t.status === "completed").length;
  const running = agents.filter((a) => a.state === "running").length + others.length;
  const current = todos.find((t) => t.status === "in_progress");
  const summary = [
    todos.length ? `${done}/${todos.length} tasks` : null,
    agents.length || others.length ? (running ? `${running} running` : `${agents.length} ${agents.length === 1 ? "agent" : "agents"} done`) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="activity-panel" aria-label="Activity">
      <button type="button" className="activity-header" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>
        <i className={`codicon codicon-chevron-${collapsed ? "right" : "down"}`} aria-hidden="true" />
        <span className="activity-title">Activity</span>
        <span className="activity-summary">{summary}</span>
        {collapsed && current && <span className="activity-current">{current.activeForm ?? current.content}</span>}
      </button>
      {!collapsed && (
        <div className="activity-body">
          {todos.length > 0 && <TodoList todos={todos} />}
          {(agents.length > 0 || others.length > 0) && (
            <ul className="activity-agents">
              {agents.map((a) => (
                <AgentRow key={a.id} agent={a} />
              ))}
              {others.map((t) => (
                <li key={t.taskId} className="activity-agent dot-progress" data-state="running">
                  <span className="activity-dot" aria-hidden="true" />
                  <span className="activity-agent-main">
                    <span className="activity-agent-label">{t.taskType === "local_bash" ? "Shell" : t.taskType === "local_agent" ? "Agent" : "Task"}</span>
                    <span className="activity-agent-desc">{t.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

import { useState } from "react";
import type { TodoItem, ToolBlock, ViewBlock } from "../../store/threadStore";
import { BlockList } from "./BlockView";
import { timelineClass, type TimelinePos } from "./timeline";

/** The header's secondary text for a tool call, like the extension's tool summary line. */
export function toolSummary(block: Pick<ToolBlock, "name" | "input">): { label: string; detail: string | null; mono: boolean } {
  const { name, input } = block;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  switch (name) {
    case "Bash":
      return { label: "Bash", detail: str("command"), mono: true };
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { label: name, detail: str("file_path"), mono: true };
    case "NotebookEdit":
      return { label: name, detail: str("notebook_path"), mono: true };
    case "Glob":
    case "Grep":
      return { label: name, detail: [str("pattern"), str("path")].filter(Boolean).join("  in  ") || null, mono: true };
    case "WebFetch":
      return { label: name, detail: str("url"), mono: true };
    case "WebSearch":
      return { label: name, detail: str("query"), mono: false };
    case "Task":
    case "Agent":
      return { label: str("subagent_type") ?? name, detail: str("description"), mono: false };
    case "TodoWrite":
      return { label: "Update Todos", detail: null, mono: false };
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return { label: name, detail: first ?? null, mono: false };
    }
  }
}

function inputText(block: ToolBlock): string {
  if (block.partialInput) return block.partialInput;
  if (block.name === "Bash" && typeof block.input.command === "string") return block.input.command;
  return JSON.stringify(block.input, null, 2);
}

export function TodoList({ todos }: { todos: TodoItem[] }) {
  const icon = (s: string) => (s === "completed" ? "pass-filled" : s === "in_progress" ? "circle-large-filled" : "circle-large-outline");
  return (
    <ul className="todo-list">
      {todos.map((t, i) => (
        <li key={i} className={`todo-item todo-${t.status}`}>
          <i className={`codicon codicon-${icon(t.status)}`} aria-hidden="true" />
          <span data-todo-status={t.status}>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

export function formatTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function ToolCard({ block, pos }: { block: ToolBlock; pos: TimelinePos }) {
  const [open, setOpen] = useState(false);
  const { label, detail, mono } = toolSummary(block);
  const dot = block.status === "running" ? "dot-progress" : block.status === "error" ? "dot-failure" : "dot-success";
  const isTask = block.children.length > 0 || block.progress !== null || block.name === "Task" || block.name === "Agent";
  const errorLine = block.status === "error" && block.result?.text ? block.result.text.split("\n")[0] : null;
  const p = block.progress;

  return (
    <div
      className={`block tool-card ${timelineClass(pos)} ${dot}`}
      data-block-kind="tool"
      data-tool-id={block.id}
      data-status={block.status}
    >
      <button type="button" className="tool-header" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">{label}</span>
        {detail && <span className={mono ? "tool-detail mono" : "tool-detail"}>{detail}</span>}
        {block.elapsedSeconds != null && block.status === "running" && <span className="tool-elapsed">{Math.round(block.elapsedSeconds)}s</span>}
      </button>
      {errorLine && <div className="tool-secondary tool-error-line">{errorLine}</div>}
      {block.todos && <TodoList todos={block.todos} />}
      {isTask && p && (
        <div className="tool-secondary">
          {[
            p.toolUses != null ? `${p.toolUses} tool ${p.toolUses === 1 ? "use" : "uses"}` : null,
            p.totalTokens != null ? `${formatTokens(p.totalTokens)} tokens` : null,
            p.lastToolName && block.status === "running" ? p.lastToolName : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {block.children.length > 0 && (
        <div className="tool-children">
          <BlockList blocks={block.children as ViewBlock[]} />
        </div>
      )}
      {open && (
        <div className="tool-body">
          <div className="tool-row">
            <div className="tool-row-label">IN</div>
            <pre className="tool-row-content">{inputText(block)}</pre>
          </div>
          {block.result && (
            <div className="tool-row">
              <div className="tool-row-label">OUT</div>
              <pre className={block.result.isError ? "tool-row-content error" : "tool-row-content"}>
                {block.result.text || (block.result.images ? `[${block.result.images} image${block.result.images > 1 ? "s" : ""}]` : "(no output)")}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

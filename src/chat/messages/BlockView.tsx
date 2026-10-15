import { memo, useState } from "react";
import type { ViewBlock } from "../../store/threadStore";
import { RewindAction } from "../../history/RewindAction";
import { Markdown } from "../markdown/Markdown";
import { ToolCard } from "./ToolCard";
import { timelineClass, timelinePos, type TimelinePos } from "./timeline";

export interface UserStamp {
  time: string;
  /** Set when the day changed since the previous user message. */
  date: string | null;
}

function UserMessage({ block, stamp }: { block: Extract<ViewBlock, { kind: "user" }>; stamp: UserStamp | null }) {
  return (
    <div className="block user-message-container" data-block-kind="user" data-uuid={block.uuid ?? undefined}>
      {stamp?.date && <div className="date-line">{stamp.date}</div>}
      {stamp && <div className="message-stamp">{stamp.time}</div>}
      {block.uuid && <RewindAction uuid={block.uuid} />}
      {block.images > 0 && (
        <div className="user-attachments">
          <span className="attachment-chip">
            <i className="codicon codicon-file-media" aria-hidden="true" /> {block.images} image{block.images > 1 ? "s" : ""}
          </span>
        </div>
      )}
      {block.text && <div className="user-message">{block.text}</div>}
    </div>
  );
}

function Thinking({ block, pos }: { block: Extract<ViewBlock, { kind: "thinking" }>; pos: TimelinePos }) {
  const [open, setOpen] = useState(false);
  const label = block.streaming
    ? "Thinking…"
    : block.durationMs != null
      ? `Thought for ${Math.max(1, Math.round(block.durationMs / 1000))}s`
      : "Thinking";
  const hasText = block.text.trim() !== "";
  return (
    <div className={`block thinking ${timelineClass(pos)}`} data-block-kind="thinking">
      <button type="button" className="thinking-summary" aria-expanded={open} disabled={!hasText} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        {hasText && <i className={`codicon codicon-chevron-right thinking-toggle${open ? " open" : ""}`} aria-hidden="true" />}
      </button>
      {open && hasText && <div className="thinking-content">{block.text}</div>}
    </div>
  );
}

export const BlockView = memo(function BlockView({ block, pos, stamp }: { block: ViewBlock; pos: TimelinePos; stamp?: UserStamp | null }) {
  switch (block.kind) {
    case "user":
      return <UserMessage block={block} stamp={stamp ?? null} />;
    case "text":
      return (
        <div className={`block assistant-text ${timelineClass(pos)}`} data-block-kind="text">
          <Markdown text={block.text} />
        </div>
      );
    case "thinking":
      return <Thinking block={block} pos={pos} />;
    case "tool":
      return <ToolCard block={block} pos={pos} />;
    case "error":
      return (
        <div className={`block error-block ${timelineClass(pos)} dot-failure`} data-block-kind="error">
          <span className="error-title">{block.title}</span>
          <div className="error-message">{block.message}</div>
        </div>
      );
    case "notice":
      return (
        <div className={`block notice notice-${block.variant}`} data-block-kind="notice">
          {block.variant === "compact" && <i className="codicon codicon-fold" aria-hidden="true" />}
          {block.variant === "warning" && <i className="codicon codicon-warning" aria-hidden="true" />}
          <span>{block.text}</span>
        </div>
      );
  }
});

/** Non-virtualized list, used for subagent children nested inside a Task card. */
export function BlockList({ blocks }: { blocks: ViewBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={b.id} block={b} pos={timelinePos(blocks, i)} />
      ))}
    </>
  );
}

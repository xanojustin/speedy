// Messages sent while the agent is working. The runtime delivers them in order as turns end.
import type { QueuedMessage } from "../store/threadStore";

function preview(content: unknown[]) {
  let text = "";
  let images = 0;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as { type?: string; text?: unknown };
    if (block.type === "text") text += (text ? " " : "") + String(block.text ?? "");
    else if (block.type === "image") images++;
  }
  return { text, images };
}

export function QueueList({ queue, onRemove }: { queue: QueuedMessage[]; onRemove(id: string): void }) {
  if (queue.length === 0) return null;
  return (
    <ul className="composer-queue" aria-label="Queued messages">
      {queue.map((q) => {
        const { text, images } = preview(q.content);
        return (
          <li key={q.id} className="composer-queued">
            {images > 0 && (
              <span className="composer-queued-images" aria-hidden="true">
                <i className="codicon codicon-file-media" /> {images}
              </span>
            )}
            <span className="composer-queued-text">{text}</span>
            <button type="button" className="composer-icon-button composer-queued-remove" aria-label="Remove queued message" title="Remove from queue" onClick={() => onRemove(q.id)}>
              <i className="codicon codicon-close" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

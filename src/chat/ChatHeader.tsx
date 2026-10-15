import { useState } from "react";
import { SessionList } from "../history/SessionList";
import { useAppStore } from "../store/appStore";

export function ChatHeader({ threadId }: { threadId: string }) {
  const project = useAppStore((s) => s.projects.find((p) => p.threads.some((t) => t.id === threadId)));
  const thread = project?.threads.find((t) => t.id === threadId);
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!project || !thread) return null;

  return (
    <div className="chat-header">
      <div className="chat-header-title" title={thread.title}>
        {thread.title}
      </div>
      <div className="chat-header-actions">
        <button
          type="button"
          className="icon-button"
          title="Past conversations"
          aria-label="Past conversations"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((o) => !o)}
        >
          <i className="codicon codicon-history" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="New conversation"
          aria-label="New conversation"
          onClick={() => useAppStore.getState().createThread(project.id)}
        >
          <i className="codicon codicon-add" aria-hidden="true" />
        </button>
      </div>
      {historyOpen && (
        <div className="chat-header-popover">
          <SessionList projectId={project.id} onClose={() => setHistoryOpen(false)} />
        </div>
      )}
    </div>
  );
}

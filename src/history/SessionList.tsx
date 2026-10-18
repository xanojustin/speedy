// U11: per-project past-conversations popover, like the extension's: search, rows with title and
// relative time, inline rename, click to resume.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { sessionsList } from "../ipc/commands";
import type { SessionMeta } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { relativeTime, renameSession, resumeSession } from "./resume";
import "./history.css";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SessionList({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const projectPath = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.path);
  const host = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.hostKey);
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ sessionId: string; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!host || !projectPath) return;
    let cancelled = false;
    sessionsList(host, projectPath).then(
      (list) => !cancelled && setSessions(list),
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [host, projectPath]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sessions ?? []).filter((s) => !q || s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  async function open(session: SessionMeta) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await resumeSession(projectId, session);
      if (outcome !== "cancelled") onClose();
    } catch (err) {
      setError(`Couldn't open "${session.title}": ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function commitRename() {
    if (!editing) return;
    const { sessionId, draft } = editing;
    const title = draft.trim();
    setEditing(null);
    const current = sessions?.find((s) => s.sessionId === sessionId);
    if (!title || title === current?.title) return;
    try {
      await renameSession(projectId, sessionId, title);
      setSessions((list) => list?.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)) ?? list);
    } catch (err) {
      setError(`Couldn't rename: ${errorText(err)}`);
    }
  }

  function onRenameKey(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") void commitRename();
    else if (e.key === "Escape") setEditing(null);
  }

  return (
    <div
      className="session-list"
      role="dialog"
      aria-label="Past conversations"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="session-list-search">
        <i className="codicon codicon-search" aria-hidden="true" />
        <input
          type="text"
          autoFocus
          value={query}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && (
        <div className="session-list-error" role="alert">
          {error}
        </div>
      )}
      <div className="session-list-items">
        {sessions === null && !error && <div className="session-list-status">Loading conversations…</div>}
        {sessions !== null && sessions.length === 0 && <div className="session-list-status">No conversations yet</div>}
        {sessions !== null && sessions.length > 0 && visible.length === 0 && (
          <div className="session-list-status">No matching conversations</div>
        )}
        {visible.map((s) =>
          editing?.sessionId === s.sessionId ? (
            <div key={s.sessionId} className="session-item editing">
              <input
                className="session-rename-input"
                aria-label="Session title"
                autoFocus
                value={editing.draft}
                onChange={(e) => setEditing({ sessionId: s.sessionId, draft: e.target.value })}
                onKeyDown={onRenameKey}
                onBlur={() => void commitRename()}
              />
            </div>
          ) : (
            <div key={s.sessionId} className="session-item">
              <button type="button" className="session-open" disabled={busy} title={s.title} onClick={() => void open(s)}>
                <span className="session-title">{s.title}</span>
                <span className="session-time">{relativeTime(s.modifiedMs)}</span>
              </button>
              <button
                type="button"
                className="session-action"
                title="Rename session"
                aria-label="Rename session"
                onClick={() => setEditing({ sessionId: s.sessionId, draft: s.title })}
              >
                <i className="codicon codicon-edit" aria-hidden="true" />
              </button>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

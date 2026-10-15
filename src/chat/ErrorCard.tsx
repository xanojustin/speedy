import { useState } from "react";
import { retryThread } from "../store/runtime";
import { useThreadRuntime, type ThreadRuntime } from "../store/threadStore";

/** Whether the thread-level error card is showing: failed, or recovering from a failure. */
export function showsErrorCard(rt: ThreadRuntime) {
  return rt.status === "crashed" || rt.status === "errored" || (rt.status === "starting" && (rt.reconnecting || rt.retrying));
}

export function ErrorCard({ threadId }: { threadId: string }) {
  const rt = useThreadRuntime(threadId);
  const [stderrOpen, setStderrOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!showsErrorCard(rt)) return null;

  const busy = rt.reconnecting || rt.retrying;
  const title = rt.reconnecting
    ? "Claude stopped unexpectedly"
    : rt.status === "errored"
      ? "Claude couldn't start"
      : "Claude stopped unexpectedly";

  const retry = () => {
    setError(null);
    retryThread(threadId).catch((e: unknown) => setError(String(e)));
  };

  return (
    <div className="thread-error-card" role="alert">
      <div className="thread-error-head">
        <i className="codicon codicon-error" aria-hidden="true" />
        <span className="thread-error-title">{title}</span>
      </div>
      {rt.detail && <div className="thread-error-detail">{rt.detail}</div>}
      {error && <div className="thread-error-detail">{error}</div>}
      {rt.stderrTail && (
        <>
          <button type="button" className="link-button" aria-expanded={stderrOpen} onClick={() => setStderrOpen((o) => !o)}>
            <i className={`codicon codicon-chevron-${stderrOpen ? "down" : "right"}`} aria-hidden="true" />
            {stderrOpen ? "Hide stderr" : "Show stderr"}
          </button>
          {stderrOpen && <pre className="thread-error-stderr">{rt.stderrTail}</pre>}
        </>
      )}
      <div className="thread-error-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={retry}>
          {busy ? (
            <>
              <i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> Reconnecting…
            </>
          ) : (
            "Retry"
          )}
        </button>
      </div>
    </div>
  );
}

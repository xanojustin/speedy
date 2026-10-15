// U11: the extension's per-message action on a user message: fork the conversation from here,
// rewind code to here, or both. Code rewinds show the files that will be restored first.
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { forkConversation, previewRewind, rewindCode, type RewindFilesResult } from "./rewind";
import "./history.css";

type Mode = "code" | "both";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function relativeTo(root: string | undefined, path: string) {
  if (root && path.startsWith(`${root.replace(/\/+$/, "")}/`)) return path.slice(root.replace(/\/+$/, "").length + 1);
  return path;
}

function RewindDialog({ threadId, uuid, mode, onClose }: { threadId: string; uuid: string; mode: Mode; onClose: () => void }) {
  const projectPath = useAppStore((s) => s.projects.find((p) => p.threads.some((t) => t.id === threadId))?.path);
  const [check, setCheck] = useState<{ ok: true; result: RewindFilesResult } | { ok: false; error: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    previewRewind(threadId, uuid).then(
      (result) => !cancelled && setCheck({ ok: true, result }),
      (err: unknown) => !cancelled && setCheck({ ok: false, error: errorText(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [threadId, uuid]);

  const result = check?.ok ? check.result : null;
  const files = result?.filesChanged ?? [];
  const canConfirm = !running && !!result?.canRewind && (files.length > 0 || mode === "both");

  async function confirm() {
    setRunning(true);
    setFailure(null);
    try {
      await rewindCode(threadId, uuid);
      if (mode === "both") await forkConversation(threadId, uuid);
      onClose();
    } catch (err) {
      setFailure(errorText(err));
      setRunning(false);
    }
  }

  return (
    <div className="rewind-overlay">
      <div className="rewind-dialog" role="dialog" aria-modal="true" aria-label={mode === "both" ? "Fork and rewind" : "Rewind code"}>
        <h2>{mode === "both" ? "Fork and rewind" : "Rewind code"}</h2>
        {mode === "both" && <p className="rewind-note">A new forked conversation will be created after rewinding.</p>}
        {check === null && <p className="rewind-loading">Checking code changes…</p>}
        {check && !check.ok && <p className="rewind-error">{check.error}</p>}
        {result && !result.canRewind && <p className="rewind-error">{result.error ?? "This message has no file checkpoint to rewind to."}</p>}
        {result?.canRewind && (
          <>
            {files.length > 0 ? (
              <>
                <p>
                  <span className="rewind-deletions">{plural(result.deletions ?? 0, "line")}</span> will be removed and{" "}
                  <span className="rewind-additions">{plural(result.insertions ?? 0, "line")}</span> will be added across{" "}
                  {plural(files.length, "file")}:
                </p>
                <ul className="rewind-files">
                  {files.map((f) => (
                    <li key={f}>{relativeTo(projectPath, f)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                The code <strong>has not changed</strong>, so no code will be restored.
              </p>
            )}
            <p className="rewind-warning">
              <i className="codicon codicon-warning" aria-hidden="true" />
              Rewinding does not affect files edited manually or via bash.
            </p>
          </>
        )}
        {failure && (
          <p className="rewind-error" role="alert">
            {failure}
          </p>
        )}
        <div className="rewind-buttons">
          <button type="button" className="primary" disabled={!canConfirm} onClick={() => void confirm()}>
            {mode === "both" ? "Continue" : "Rewind"}
          </button>
          <button type="button" onClick={onClose}>
            Never mind
          </button>
        </div>
      </div>
    </div>
  );
}

/** `threadId` is the thread whose transcript holds this user message (passed down by the transcript). */
export function RewindAction({ threadId, uuid }: { threadId: string; uuid: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<Mode | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function fork() {
    setMenuOpen(false);
    forkConversation(threadId, uuid).catch((err: unknown) =>
      useThreadStore.getState().dispatch(threadId, { kind: "local_notice", variant: "warning", text: `Failed to fork conversation: ${errorText(err)}` }),
    );
  }

  return (
    <div className="rewind-action" ref={ref}>
      <button
        type="button"
        className="rewind-button"
        title="Message actions"
        aria-label="Message actions"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <i className="codicon codicon-discard" aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="rewind-popup" role="menu">
          <button type="button" role="menuitem" onClick={fork}>
            Fork conversation from here
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setDialog("code");
            }}
          >
            Rewind code to here
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setDialog("both");
            }}
          >
            Fork conversation and rewind code
          </button>
        </div>
      )}
      {dialog && <RewindDialog threadId={threadId} uuid={uuid} mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

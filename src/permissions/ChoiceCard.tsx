// U10: the shared frame of every permission card: content, numbered choices, an optional
// "No" + "Tell Claude what to do instead" row, and the extension's keyboard model
// (1..n pick a choice, Enter on the focused one, ArrowUp/Down move, Escape denies).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PermissionOutcome, PermissionResult } from "../ipc/types";
import { respondPermission } from "../store/runtime";

export interface Choice {
  label: ReactNode;
  /** Secondary line under the label (e.g. where an always-allow rule is saved). */
  detail?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export interface DenyChoice {
  label: string;
  onDeny: (feedback: string) => void;
}

function inTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "checkbox" && el.type !== "radio");
}

/** Sends a response for one request; tracks busy/error and whether the shown diff went stale. */
export function useResponder(threadId: string, requestId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const busyRef = useRef(false);
  const respond = useCallback(
    async (result: PermissionResult): Promise<PermissionOutcome | null> => {
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const outcome = await respondPermission(threadId, requestId, result);
        // On a stale diff nothing was sent: the store now holds the refreshed diff, and the
        // user has to accept again (KTD5).
        if (!outcome.sent) setStale(true);
        return outcome;
      } catch (err) {
        setError(`Couldn't send your answer: ${String(err)}`);
        return null;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [threadId, requestId],
  );
  return { busy, error, stale, respond };
}

export function ChoiceCard({
  className,
  children,
  choices,
  deny,
  onEscape,
  busy,
  notice,
  error,
}: {
  className?: string;
  children: ReactNode;
  choices: Choice[];
  deny?: DenyChoice;
  /** Escape when there is no deny row (e.g. a question card's dismiss). */
  onEscape?: () => void;
  busy: boolean;
  notice?: ReactNode;
  error?: string | null;
}) {
  const [feedback, setFeedback] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const focusables = () => [...buttonsRef.current.slice(0, choices.length + (deny ? 1 : 0)), deny ? inputRef.current : null].filter(
    (el): el is HTMLButtonElement | HTMLInputElement => el !== null,
  );

  // Like the extension, take focus on arrival unless the user is typing somewhere.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && inTextField(active)) return;
    const first = buttonsRef.current.find((b) => b && !b.disabled);
    first?.focus({ preventScroll: true });
  }, []); // on mount only

  const doDeny = () => deny?.onDeny(feedback);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.repeat && (e.key === "Enter" || e.key === "Escape" || /^[0-9]$/.test(e.key))) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (busy) return;
      if (deny) doDeny();
      else onEscape?.();
      return;
    }
    if (inTextField(e.target)) return;
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1;
      if (n < choices.length) {
        e.preventDefault();
        if (!busy && !choices[n].disabled) choices[n].onSelect();
      } else if (deny && n === choices.length) {
        e.preventDefault();
        if (!busy) doDeny();
      } else if (deny && n === choices.length + 1) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = focusables();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      if (at === -1 && rootRef.current?.contains(document.activeElement) && document.activeElement !== rootRef.current) return;
      e.preventDefault();
      const next = at === -1 ? 0 : (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    }
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      if (!busy) doDeny();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // Let the card move focus between choices.
    } else {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busy) doDeny();
      }
    }
  };

  return (
    <div ref={rootRef} className={`perm-card ${className ?? ""}`} tabIndex={-1} onKeyDown={onKeyDown} aria-busy={busy}>
      <div className="perm-content">{children}</div>
      {notice && (
        <div className="perm-notice" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="perm-error" role="alert">
          {error}
        </div>
      )}
      <div className="perm-buttons">
        {choices.map((c, i) => (
          <button
            key={i}
            ref={(el) => {
              buttonsRef.current[i] = el;
            }}
            type="button"
            className={`perm-button ${i === 0 ? "perm-primary" : ""}`}
            disabled={busy || c.disabled}
            onClick={c.onSelect}
          >
            <span className="perm-shortcut">{i + 1}</span> {c.label}
            {c.detail && <span className="perm-detail">{c.detail}</span>}
          </button>
        ))}
        {deny && (
          <>
            <button
              ref={(el) => {
                buttonsRef.current[choices.length] = el;
              }}
              type="button"
              className="perm-button"
              disabled={busy}
              onClick={doDeny}
            >
              <span className="perm-shortcut">{choices.length + 1}</span> {deny.label}
            </button>
            <input
              ref={inputRef}
              className="perm-feedback"
              type="text"
              placeholder="Tell Claude what to do instead"
              value={feedback}
              disabled={busy}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={onInputKeyDown}
            />
          </>
        )}
      </div>
      <div className="perm-hints">Esc to cancel</div>
    </div>
  );
}

// Answers an SSH passphrase or 2FA prompt (KTD2): ssh asks the app through SSH_ASKPASS, and
// the answer goes straight back to that one prompt. Nothing typed here is kept.
import { useEffect, useState } from "react";
import { askpassAnswer, onAskpass } from "../ipc/commands";
import type { AskpassPrompt } from "../ipc/types";
import { hostLabel } from "../store/appStore";
import "./hosts.css";

export function AskpassDialog() {
  const [prompts, setPrompts] = useState<AskpassPrompt[]>([]);
  const [value, setValue] = useState("");

  useEffect(() => {
    const unlisten = onAskpass((p) => setPrompts((all) => [...all, p]));
    return () => void unlisten.then((fn) => fn());
  }, []);

  const current = prompts[0];
  if (!current) return null;
  const finish = (answer: string | null) => {
    void askpassAnswer(current.id, answer).catch((err) => console.warn("answering the SSH prompt failed", err));
    setValue("");
    setPrompts((all) => all.slice(1));
  };

  return (
    <div className="settings-backdrop">
      <form
        className="settings-dialog askpass-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="askpass-title"
        onSubmit={(e) => {
          e.preventDefault();
          finish(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(null);
          }
        }}
      >
        <header className="settings-header">
          <h2 id="askpass-title" className="settings-title">
            SSH to {hostLabel(current.host)}
          </h2>
        </header>
        <p className="askpass-prompt">{current.prompt}</p>
        <input
          className="vscode-input"
          type="password"
          aria-label={current.prompt}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <footer className="askpass-actions">
          <button type="button" className="secondary-button" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            Continue
          </button>
        </footer>
      </form>
    </div>
  );
}

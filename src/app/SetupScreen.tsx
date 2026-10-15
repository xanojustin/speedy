// Blocking setup screen when the `claude` CLI is missing, logged out, or failing (R13).
import { useState } from "react";
import { recheckSetup } from "../ipc/commands";
import type { SetupState } from "../ipc/types";
import { useAppStore } from "../store/appStore";

const TITLES: Record<string, string> = {
  cli_not_found: "Claude Code CLI not found",
  not_logged_in: "Not logged in to Claude Code",
  error: "Couldn't start Claude Code",
};

export function SetupScreen({ setup, onChange }: { setup: SetupState; onChange: (s: SetupState) => void }) {
  const savedOverride = useAppStore((s) => s.claudePathOverride);
  const setClaudePathOverride = useAppStore((s) => s.setClaudePathOverride);
  const [path, setPath] = useState(savedOverride ?? "");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recheck = async () => {
    const override = path.trim() || null;
    setClaudePathOverride(override);
    setChecking(true);
    setError(null);
    try {
      onChange(await recheckSetup(override));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <span className="codicon codicon-warning setup-icon" aria-hidden />
        <h1 className="setup-title">{TITLES[setup.status] ?? "Setup required"}</h1>

        {setup.status === "cli_not_found" && (
          <>
            <p>Speedy runs the Claude Code CLI installed on this Mac, and couldn't find a <code>claude</code> binary.</p>
            {setup.searchedPaths.length > 0 && (
              <>
                <p className="setup-label">Searched:</p>
                <ul className="setup-paths">
                  {setup.searchedPaths.map((p) => (
                    <li key={p}>
                      <code>{p}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p>
              Install it with <code>curl -fsSL https://claude.ai/install.sh | bash</code> or{" "}
              <code>npm install -g @anthropic-ai/claude-code</code>, then click Recheck. If it's installed somewhere
              else, enter its path below.
            </p>
          </>
        )}

        {setup.status === "not_logged_in" && (
          <p>
            Run <code>claude auth login</code> in a terminal, then click Recheck. Speedy uses your own CLI login and never
            sees your credentials.
          </p>
        )}

        {setup.message && <p className="setup-message">{setup.message}</p>}
        {error && <p className="setup-message setup-error">{error}</p>}

        <form
          className="setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void recheck();
          }}
        >
          <input
            className="vscode-input setup-path"
            aria-label="Path to claude"
            placeholder="Path to claude (optional), e.g. /opt/homebrew/bin/claude"
            value={path}
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
          />
          <button type="submit" className="vscode-button" disabled={checking}>
            {checking ? "Checking…" : "Recheck"}
          </button>
        </form>
      </div>
    </div>
  );
}

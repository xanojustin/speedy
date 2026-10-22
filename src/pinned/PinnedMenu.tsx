// The composer footer's Commands pill: the thread's pinned commands in a menu above it, like the
// mode and model menus, and a way into Settings to add or edit them. Hidden while the thread's host
// has none; they're added in Settings › Pinned Commands.
import { useMemo, useRef, useState } from "react";
import { useDismiss } from "../composer/Pickers";
import { pinnedCommandsFor, useAppStore } from "../store/appStore";
import { pinnedActionLabel, pinnedIcon, runPinnedCommand } from "./run";
import "./pinned.css";

export function PinnedMenu({ threadId, hostKey, hostAway }: { threadId: string; hostKey: string; hostAway: boolean }) {
  const all = useAppStore((s) => s.pinnedCommands);
  const commands = useMemo(() => pinnedCommandsFor(all, hostKey), [all, hostKey]);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const refs = useRef([button, popup]).current;
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, refs);
  if (commands.length === 0) return null;

  return (
    <div className="composer-menu-host">
      <button
        ref={button}
        type="button"
        className="pinned-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Pinned commands"
        title="Pinned commands"
        onClick={() => setOpen((o) => !o)}
      >
        <i className="codicon codicon-pinned" aria-hidden="true" />
        Commands
        <span className="pinned-pill-count">{commands.length}</span>
      </button>
      {open && (
        <div ref={popup} className="composer-menu pinned-menu" role="menu" aria-label="Pinned commands">
          <div className="composer-menu-header">
            <span className="composer-menu-title">Pinned Commands</span>
            <span className="composer-menu-hint">Runs in this thread's folder</span>
          </div>
          {commands.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="composer-menu-item"
              disabled={hostAway}
              title={c.command}
              onClick={() => {
                setOpen(false);
                runPinnedCommand(threadId, c);
              }}
            >
              <i className={`codicon codicon-${pinnedIcon(c)} composer-menu-icon`} aria-hidden="true" />
              <span className="composer-menu-text">
                <span className="composer-menu-label">{c.name}</span>
                <span className="composer-menu-description pinned-menu-command">
                  {pinnedActionLabel(c)} · <code>{c.command}</code>
                </span>
              </span>
            </button>
          ))}
          <div className="composer-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="composer-menu-item"
            onClick={() => {
              setOpen(false);
              useAppStore.getState().setSettingsOpen(true, "pinned");
            }}
          >
            <i className="codicon codicon-settings-gear composer-menu-icon" aria-hidden="true" />
            <span className="composer-menu-text">
              <span className="composer-menu-label">Add or edit commands…</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

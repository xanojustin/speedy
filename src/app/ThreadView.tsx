// The selected thread: chat on top, its terminal docked below like VS Code's panel (R16).
import { useRef, useState } from "react";
import { ChatPane } from "../chat/ChatPane";
import type { Project, Thread } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { TerminalPane } from "../terminal/TerminalPane";
import { toggleMaximizeTerminal, toggleTerminal } from "./shortcuts";

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
const clamp = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

export function ThreadView({ project, thread }: { project: Project; thread: Thread }) {
  const updateThread = useAppStore((s) => s.updateThread);
  const splitRef = useRef<HTMLDivElement>(null);
  // While dragging the sash the ratio lives here; it's persisted once on release.
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  const terminalShown = thread.terminalVisible;
  const maximized = terminalShown && thread.terminalMaximized;
  const ratio = dragRatio ?? thread.splitRatio;

  const onSashPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const ratioAt = (clientY: number) => {
      const r = splitRef.current!.getBoundingClientRect();
      return r.height > 0 ? clamp((clientY - r.top) / r.height) : ratio;
    };
    let latest = ratio;
    const onMove = (ev: PointerEvent) => {
      latest = ratioAt(ev.clientY);
      setDragRatio(latest);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (ev.type === "pointerup") latest = ratioAt(ev.clientY);
      setDragRatio(null);
      updateThread(thread.id, { splitRatio: Math.round(latest * 1000) / 1000 });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const chatStyle =
    terminalShown && !maximized ? { flexGrow: 0, flexShrink: 0, flexBasis: pct(ratio) } : { flexGrow: 1, flexShrink: 1, flexBasis: "auto" };

  return (
    <div ref={splitRef} className={`thread-split${dragRatio !== null ? " resizing" : ""}`}>
      <section className="chat-region" data-thread-id={thread.id} hidden={maximized} style={chatStyle} aria-label="Chat">
        <ChatPane threadId={thread.id} />
      </section>
      {terminalShown && !maximized && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          aria-valuenow={Math.round(ratio * 100)}
          className="sash sash-horizontal"
          onPointerDown={onSashPointerDown}
        />
      )}
      <section className="terminal-region" data-thread-id={thread.id} hidden={!terminalShown} aria-label="Terminal">
        <div className="panel-header">
          <span className="panel-title">Terminal</span>
          <span className="panel-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={maximized ? "Restore Panel Size" : "Maximize Panel Size"}
              title={`${maximized ? "Restore" : "Maximize"} Panel Size (⇧⌘J)`}
              onClick={() => toggleMaximizeTerminal(thread.id)}
            >
              <span className={`codicon codicon-chevron-${maximized ? "down" : "up"}`} aria-hidden />
            </button>
            <button type="button" className="icon-button" aria-label="Hide Panel" title="Hide Panel (⌘J)" onClick={() => toggleTerminal(thread.id)}>
              <span className="codicon codicon-close" aria-hidden />
            </button>
          </span>
        </div>
        <div className="terminal-body">
          <TerminalPane threadId={thread.id} cwd={project.path} visible={terminalShown} />
        </div>
      </section>
    </div>
  );
}

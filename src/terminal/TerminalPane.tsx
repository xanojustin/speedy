// U7: xterm.js terminal bound to one PTY (a thread's terminal tab).
// `visible` false means the pane is hidden (another tab, thread not selected, or panel toggled off):
// keep the xterm instance and buffer alive, drop the WebGL context (KTD3).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { FindWidget } from "./FindWidget";
import { attachTerminal, type AttachedTerminal } from "./registry";

export { disposeTerminal, disposeThreadTerminals } from "./registry";

export function TerminalPane({
  terminalId,
  cwd,
  visible,
  onAddToChat,
}: {
  terminalId: string;
  cwd: string;
  visible: boolean;
  /** Cmd+L over a selection hands it here. */
  onAddToChat?: (text: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const attached = useRef<AttachedTerminal | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const addToChat = useRef(onAddToChat);
  addToChat.current = onAddToChat;

  useLayoutEffect(() => {
    const t = attachTerminal(
      terminalId,
      cwd,
      hostRef.current!,
      visible,
      () => setFindOpen(true),
      (text) => addToChat.current?.(text),
    );
    attached.current = t;
    return () => {
      t.detach();
      attached.current = null;
    };
    // cwd is fixed for a terminal's lifetime; `visible` changes go through setVisible below.
  }, [terminalId]);

  // Focus when this terminal is shown (panel toggled open or tab selected), not on first mount.
  const prev = useRef({ terminalId, visible });
  useLayoutEffect(() => {
    attached.current?.setVisible(visible);
    if (visible && !prev.current.visible && prev.current.terminalId === terminalId) attached.current?.focus();
    prev.current = { terminalId, visible };
  }, [visible, terminalId]);

  useEffect(() => setFindOpen(false), [terminalId]);

  const closeFind = () => {
    setFindOpen(false);
    attached.current?.clearFind();
    attached.current?.focus();
  };

  return (
    <div className="terminal-pane" data-thread={terminalId} hidden={!visible}>
      <div className="terminal-host" ref={hostRef} />
      {findOpen && (
        <FindWidget onFind={(q, back, inc) => attached.current?.find(q, back, inc) ?? false} onClose={closeFind} />
      )}
    </div>
  );
}

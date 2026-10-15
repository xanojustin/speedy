// U7: xterm.js terminal bound to the thread's PTY.
// `visible` false means the pane is hidden (thread not selected or terminal toggled off):
// keep the xterm instance and buffer alive, drop the WebGL context (KTD3).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { FindWidget } from "./FindWidget";
import { attachTerminal, type AttachedTerminal } from "./registry";

export { disposeTerminal } from "./registry";

export function TerminalPane({ threadId, cwd, visible }: { threadId: string; cwd: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const attached = useRef<AttachedTerminal | null>(null);
  const [findOpen, setFindOpen] = useState(false);

  useLayoutEffect(() => {
    const t = attachTerminal(threadId, cwd, hostRef.current!, visible, () => setFindOpen(true));
    attached.current = t;
    return () => {
      t.detach();
      attached.current = null;
    };
    // cwd is fixed for a thread's lifetime; `visible` changes go through setVisible below.
  }, [threadId]);

  // Focus when this thread's terminal is toggled open, but not when switching threads.
  const prev = useRef({ threadId, visible });
  useLayoutEffect(() => {
    attached.current?.setVisible(visible);
    if (visible && !prev.current.visible && prev.current.threadId === threadId) attached.current?.focus();
    prev.current = { threadId, visible };
  }, [visible, threadId]);

  useEffect(() => setFindOpen(false), [threadId]);

  const closeFind = () => {
    setFindOpen(false);
    attached.current?.clearFind();
    attached.current?.focus();
  };

  return (
    <div className="terminal-pane" data-thread={threadId} hidden={!visible}>
      <div className="terminal-host" ref={hostRef} />
      {findOpen && (
        <FindWidget onFind={(q, back, inc) => attached.current?.find(q, back, inc) ?? false} onClose={closeFind} />
      )}
    </div>
  );
}

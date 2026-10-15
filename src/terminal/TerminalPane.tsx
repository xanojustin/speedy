// U7: xterm.js terminal bound to the thread's PTY. STUB.
// `visible` false means the pane is hidden (thread not selected or terminal toggled off):
// keep the xterm instance and buffer alive, drop the WebGL context (KTD3).
export function TerminalPane({ threadId, cwd, visible }: { threadId: string; cwd: string; visible: boolean }) {
  return <div className="terminal-pane" data-thread={threadId} data-cwd={cwd} hidden={!visible} />;
}

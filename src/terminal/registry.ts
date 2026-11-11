// U7: one xterm per terminal (a thread can have several, see ./tabs.ts), alive until the
// terminal is killed or its thread archived, and independent of React mounting (KTD2, KTD3).
// The shell starts the first time the terminal is shown, so selecting a thread with its panel
// closed costs no shell; once started, a hidden terminal's output keeps landing in its buffer.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openPath, ptyClose, ptyOpen, ptyResize, ptyWrite } from "../ipc/commands";
import type { PtyExit } from "../ipc/types";
import { terminalKeyAction } from "./keys";
import { useTerminalTabs } from "./tabs";
import { attachWebgl } from "./webgl";

const RESIZE_DEBOUNCE_MS = 50;

interface Entry {
  terminalId: string;
  cwd: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  container: HTMLDivElement;
  opened: boolean;
  /** The shell has been started at least once (it starts on first show). */
  started: boolean;
  /** The shell exited (or failed to start); Enter restarts it. */
  exited: boolean;
  /**
   * Drops the current subscription. Null before `ptyOpen` resolves, and after detaching. A
   * subscription that resolves once its open is no longer `opening` detaches itself.
   */
  detach: (() => void) | null;
  /** Identifies the latest open, so a stale one's subscription is dropped when it resolves. */
  opening: object | null;
  releaseWebgl: (() => void) | null;
  onFind: (() => void) | null;
  onAddToChat: ((text: string) => void) | null;
}

const entries = new Map<string, Entry>();
/** Input for a terminal's shell once it starts (a pinned command run in a new tab). */
const pendingInput = new Map<string, string>();

// ---- theme (VS Code Dark Modern fallbacks when a token is unset) ----

const FALLBACK: Record<string, string> = {
  "terminal-background": "#181818",
  "terminal-foreground": "#cccccc",
  "terminalCursor-foreground": "#aeafad",
  "terminal-selectionBackground": "#264f78",
  "terminal-ansiBlack": "#000000",
  "terminal-ansiRed": "#cd3131",
  "terminal-ansiGreen": "#0dbc79",
  "terminal-ansiYellow": "#e5e510",
  "terminal-ansiBlue": "#2472c8",
  "terminal-ansiMagenta": "#bc3fbc",
  "terminal-ansiCyan": "#11a8cd",
  "terminal-ansiWhite": "#e5e5e5",
  "terminal-ansiBrightBlack": "#666666",
  "terminal-ansiBrightRed": "#f14c4c",
  "terminal-ansiBrightGreen": "#23d18b",
  "terminal-ansiBrightYellow": "#f5f543",
  "terminal-ansiBrightBlue": "#3b8eea",
  "terminal-ansiBrightMagenta": "#d670d6",
  "terminal-ansiBrightCyan": "#29b8db",
  "terminal-ansiBrightWhite": "#e5e5e5",
};

const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"] as const;

function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(`--vscode-${name}`).trim() || FALLBACK[name];
  const theme: Record<string, string> = {
    background: v("terminal-background"),
    foreground: v("terminal-foreground"),
    cursor: v("terminalCursor-foreground"),
    cursorAccent: v("terminal-background"),
    selectionBackground: v("terminal-selectionBackground"),
  };
  for (const c of ANSI) {
    theme[c.toLowerCase()] = v(`terminal-ansi${c}`);
    theme[`bright${c}`] = v(`terminal-ansiBright${c}`);
  }
  return theme as ITheme;
}

// ---- module-level listeners, installed with the first terminal ----

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  // The theme tokens change with the OS appearance; re-read them after a light/dark switch.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    requestAnimationFrame(() => {
      const theme = readTheme();
      for (const e of entries.values()) e.term.options.theme = theme;
    });
  });
}

// ---- PTY ----

/** Drops the terminal's subscription, so a reconnect doesn't start its shell again. */
function detachPty(entry: Entry) {
  entry.opening = null;
  entry.detach?.();
  entry.detach = null;
}

function onExit(e: PtyExit) {
  const entry = entries.get(e.terminalId);
  if (!entry) return;
  entry.exited = true;
  detachPty(entry);
  const status = e.code == null ? "[Process exited]" : `[Process exited with code ${e.code}]`;
  entry.term.write(`\r\n${status} — press Enter to restart\r\n`);
}

function startPty(entry: Entry) {
  const { terminalId, cwd, term } = entry;
  detachPty(entry); // a restart replaces the exited shell's subscription
  const opening = {};
  entry.opening = opening;
  entry.started = true;
  entry.exited = false;
  ptyOpen(terminalId, cwd, term.cols, term.rows, (bytes) => term.write(bytes), onExit).then((detach) => {
    if (entry.opening !== opening) {
      // Disposed, exited or restarted while opening.
      detach?.();
      return;
    }
    entry.opening = null;
    entry.detach = detach ?? null;
    const input = pendingInput.get(terminalId);
    if (input === undefined || entries.get(terminalId) !== entry) return;
    pendingInput.delete(terminalId);
    void ptyWrite(terminalId, input).catch(() => {});
  }, (err) => {
    if (entry.opening !== opening) return;
    entry.opening = null;
    entry.exited = true;
    term.write(`\r\n\x1b[31m[Failed to start shell: ${String(err)}]\x1b[0m — press Enter to retry\r\n`);
  });
}

function create(terminalId: string, cwd: string): Entry {
  listenOnce();
  const term = new Terminal({
    allowProposedApi: true, // unicode11
    macOptionIsMeta: true,
    scrollback: 10000,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    fontSize: 12,
    cursorBlink: false, // VS Code's terminal.integrated.cursorBlinking default
    theme: readTheme(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon((_event, uri) => void openPath(uri).catch(() => {})));

  const container = document.createElement("div");
  container.className = "terminal-instance";
  const entry: Entry = {
    terminalId,
    cwd,
    term,
    fit,
    search,
    container,
    opened: false,
    started: false,
    exited: false,
    detach: null,
    opening: null,
    releaseWebgl: null,
    onFind: null,
    onAddToChat: null,
  };

  term.attachCustomKeyEventHandler((e) => {
    const action = terminalKeyAction(e, term.hasSelection());
    if (action.type === "xterm") return true;
    if (e.type !== "keydown") return false;
    switch (action.type) {
      case "clear":
        term.clear();
        break;
      case "copy":
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        break;
      case "selectAll":
        term.selectAll();
        break;
      case "find":
        entry.onFind?.();
        break;
      case "addToChat":
        entry.onAddToChat?.(term.getSelection());
        term.clearSelection();
        break;
      case "send":
        term.input(action.data);
        break;
      case "native":
      case "ignore":
        return false;
    }
    e.preventDefault();
    return false;
  });
  // Everything typed or pasted reaches the shell through xterm's onData, so
  // xterm applies bracketed paste and Option-as-Meta.
  term.onData((data) => {
    if (entry.exited) {
      if (data === "\r") startPty(entry);
      return;
    }
    void ptyWrite(terminalId, data).catch(() => {});
  });
  term.onTitleChange((title) => useTerminalTabs.getState().setTitle(terminalId, title));
  term.onResize(({ cols, rows }) => {
    if (!entry.exited) void ptyResize(terminalId, cols, rows).catch(() => {});
  });

  entries.set(terminalId, entry);
  return entry;
}

function fitNow(entry: Entry) {
  try {
    entry.fit.fit();
  } catch {
    // Not measurable while detached or zero-sized; the next resize fits it.
  }
}

export interface AttachedTerminal {
  setVisible(visible: boolean): void;
  detach(): void;
  find(query: string, backwards: boolean, incremental?: boolean): boolean;
  clearFind(): void;
  focus(): void;
}

/**
 * Puts the terminal's persistent xterm into `host`, creating it and starting its
 * PTY the first time. `detach` removes it from `host` without disposing anything.
 * xterm is opened on the first visible attach, because a `display: none` host
 * can't be measured; output written before that is buffered.
 * `onAddToChat` receives the selection when the user presses Cmd+L over one.
 */
export function attachTerminal(
  terminalId: string,
  cwd: string,
  host: HTMLElement,
  initiallyVisible: boolean,
  onFind: () => void,
  onAddToChat: (text: string) => void,
): AttachedTerminal {
  const entry = entries.get(terminalId) ?? create(terminalId, cwd);
  host.appendChild(entry.container);
  entry.onFind = onFind;
  entry.onAddToChat = onAddToChat;
  let visible = false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => visible && fitNow(entry), RESIZE_DEBOUNCE_MS);
        });
  observer?.observe(host);

  const dropWebgl = () => {
    entry.releaseWebgl?.();
    entry.releaseWebgl = null;
  };

  const setVisible = (v: boolean) => {
    visible = v;
    if (!v) return dropWebgl();
    if (!entry.opened) {
      entry.term.open(entry.container);
      entry.opened = true;
    }
    fitNow(entry);
    entry.releaseWebgl ??= attachWebgl(entry.term);
    // Started on first show, after the fit, so the shell starts at its real size.
    if (!entry.started) startPty(entry);
  };
  setVisible(initiallyVisible);

  return {
    setVisible,
    detach() {
      visible = false;
      clearTimeout(timer);
      observer?.disconnect();
      dropWebgl();
      if (entry.onFind === onFind) entry.onFind = null;
      if (entry.onAddToChat === onAddToChat) entry.onAddToChat = null;
      entry.container.remove();
    },
    find(query, backwards, incremental = false) {
      return backwards
        ? entry.search.findPrevious(query)
        : entry.search.findNext(query, { incremental });
    },
    clearFind() {
      entry.search.clearDecorations();
      entry.term.clearSelection();
    },
    focus() {
      entry.term.focus();
    },
  };
}

/** Types `data` into a terminal that hasn't started yet, as soon as its shell does. */
export function queueTerminalInput(terminalId: string, data: string): void {
  pendingInput.set(terminalId, data);
}

/** Focuses the terminal if it's open on screen. */
export function focusTerminal(terminalId: string): void {
  const entry = entries.get(terminalId);
  if (entry?.opened) entry.term.focus();
}

/**
 * Disposes the terminal's xterm and closes its shell (terminal killed or thread archived). Closes
 * the shell even when this window has no xterm for it: the host outlives the app, so a shell
 * started before the app last launched has no entry here.
 */
export function disposeTerminal(terminalId: string): void {
  const entry = entries.get(terminalId);
  pendingInput.delete(terminalId);
  if (entry) {
    entries.delete(terminalId);
    detachPty(entry);
    entry.releaseWebgl?.();
    entry.container.remove();
    entry.term.dispose();
  }
  void ptyClose(terminalId).catch(() => {});
}

/** Disposes every terminal of the thread and forgets its tabs (thread archived). */
export function disposeThreadTerminals(threadId: string): void {
  for (const id of useTerminalTabs.getState().forgetThread(threadId)) disposeTerminal(id);
}

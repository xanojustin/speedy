// U7: terminal key mapping (KTD10). Pure so it can be tested without xterm.

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type KeyAction =
  | { type: "xterm" }
  | { type: "native" }
  | { type: "ignore" }
  | { type: "clear" }
  | { type: "copy" }
  | { type: "selectAll" }
  | { type: "find" }
  | { type: "send"; data: string };

/**
 * What a key does while the terminal has focus. The terminal gets first claim,
 * except Cmd combinations it doesn't own: those go to the native menu
 * (new thread, switch thread, quit, ...). Ctrl and Option keys always reach
 * xterm, which turns Option into Meta (`macOptionIsMeta`).
 */
export function terminalKeyAction(e: KeyLike, hasSelection: boolean): KeyAction {
  if (!e.metaKey) return { type: "xterm" };
  if (e.ctrlKey || e.altKey || e.shiftKey) return { type: "native" };
  switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
    case "k":
      return { type: "clear" };
    case "c":
      return hasSelection ? { type: "copy" } : { type: "ignore" };
    case "v":
      // The browser's paste event reaches xterm's textarea, which applies
      // bracketed-paste markers when the shell enabled them.
      return { type: "native" };
    case "a":
      return { type: "selectAll" };
    case "f":
      return { type: "find" };
    case "ArrowLeft":
      return { type: "send", data: "\x01" };
    case "ArrowRight":
      return { type: "send", data: "\x05" };
    default:
      return { type: "native" };
  }
}

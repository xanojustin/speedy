import { describe, expect, it } from "vitest";
import { terminalKeyAction, type KeyLike } from "./keys";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const cmd = (k: string, mods: Partial<KeyLike> = {}) => key(k, { metaKey: true, ...mods });

describe("terminalKeyAction", () => {
  it("Cmd+K clears without sending bytes", () => {
    expect(terminalKeyAction(cmd("k"), false)).toEqual({ type: "clear" });
  });

  it("Cmd+C copies only with a selection, otherwise sends nothing", () => {
    expect(terminalKeyAction(cmd("c"), true)).toEqual({ type: "copy" });
    expect(terminalKeyAction(cmd("c"), false)).toEqual({ type: "ignore" });
  });

  it("Cmd+V leaves paste to the native paste event", () => {
    expect(terminalKeyAction(cmd("v"), false)).toEqual({ type: "native" });
  });

  it("Cmd+A selects all, Cmd+F opens find", () => {
    expect(terminalKeyAction(cmd("a"), false)).toEqual({ type: "selectAll" });
    expect(terminalKeyAction(cmd("f"), false)).toEqual({ type: "find" });
  });

  it("Cmd+Left/Right send line start/end", () => {
    expect(terminalKeyAction(cmd("ArrowLeft"), false)).toEqual({ type: "send", data: "\x01" });
    expect(terminalKeyAction(cmd("ArrowRight"), false)).toEqual({ type: "send", data: "\x05" });
  });

  it("app shortcuts are not consumed by the terminal", () => {
    for (const k of ["n", "w", "j", "l", "o", "q", "1", "9", ","]) {
      expect(terminalKeyAction(cmd(k), false), `Cmd+${k}`).toEqual({ type: "native" });
    }
    expect(terminalKeyAction(cmd("K", { shiftKey: true }), false)).toEqual({ type: "native" });
    expect(terminalKeyAction(cmd("f", { ctrlKey: true }), false)).toEqual({ type: "native" });
  });

  it("Ctrl and Option keys go to xterm (and from there to the shell)", () => {
    expect(terminalKeyAction(key("r", { ctrlKey: true }), false)).toEqual({ type: "xterm" });
    expect(terminalKeyAction(key("c", { ctrlKey: true }), true)).toEqual({ type: "xterm" });
    expect(terminalKeyAction(key("∫", { altKey: true }), false)).toEqual({ type: "xterm" });
    expect(terminalKeyAction(key("a"), false)).toEqual({ type: "xterm" });
  });
});

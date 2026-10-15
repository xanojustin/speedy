import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyExit } from "../ipc/types";

// ---- fakes: Tauri IPC and the WebGL addon (jsdom has no WebGL) ----
const ipc = vi.hoisted(() => ({
  ptyOpen: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  ptyClose: vi.fn(),
  onPtyExit: vi.fn(),
  openPath: vi.fn(),
}));
vi.mock("../ipc/commands", () => ipc);

const webgl = vi.hoisted(() => {
  class FakeWebglAddon {
    static instances: FakeWebglAddon[] = [];
    disposed = false;
    loseContext: () => void = () => {};
    constructor() {
      FakeWebglAddon.instances.push(this);
    }
    onContextLoss(cb: () => void) {
      this.loseContext = cb;
      return { dispose() {} };
    }
    activate() {}
    dispose() {
      this.disposed = true;
    }
  }
  return { FakeWebglAddon, live: () => FakeWebglAddon.instances.filter((a) => !a.disposed) };
});
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: webgl.FakeWebglAddon }));

import { TerminalPane, disposeTerminal } from "./TerminalPane";

const enc = new TextEncoder();
let exitListener: (e: PtyExit) => void = () => {};
/** The `onData` callback the registry handed to `ptyOpen` for a thread (latest open). */
const output = (threadId: string) => (text: string) => {
  const call = ipc.ptyOpen.mock.calls.filter((c) => c[0] === threadId).at(-1);
  if (!call) throw new Error(`no ptyOpen for ${threadId}`);
  act(() => call[4](enc.encode(text)));
};
const textarea = () => document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
const press = (init: KeyboardEventInit) => {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    textarea().dispatchEvent(ev);
  });
  return ev;
};
const screenText = () => document.querySelector(".xterm-rows")?.textContent ?? "";
const written = () => ipc.ptyWrite.mock.calls.map((c) => c[1]);
const used = new Set<string>();
const pane = (threadId: string, visible = true) => {
  used.add(threadId);
  return <TerminalPane threadId={threadId} cwd={`/proj/${threadId}`} visible={visible} />;
};

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  vi.clearAllMocks();
  ipc.ptyOpen.mockResolvedValue(undefined);
  ipc.ptyWrite.mockResolvedValue(undefined);
  ipc.ptyResize.mockResolvedValue(undefined);
  ipc.ptyClose.mockResolvedValue(undefined);
  ipc.onPtyExit.mockImplementation(async (cb: (e: PtyExit) => void) => {
    exitListener = cb;
    return () => {};
  });
});

afterEach(() => {
  cleanup();
  for (const id of used) disposeTerminal(id);
  used.clear();
});

describe("TerminalPane", () => {
  it("opens the thread's PTY in its folder and forwards typing to it", async () => {
    render(pane("t1"));
    expect(ipc.ptyOpen).toHaveBeenCalledTimes(1);
    expect(ipc.ptyOpen.mock.calls[0].slice(0, 2)).toEqual(["t1", "/proj/t1"]);
    press({ key: "s", code: "KeyS", keyCode: 83 });
    await vi.waitFor(() => expect(written()).toEqual(["s"]));
    expect(ipc.ptyWrite.mock.calls[0][0]).toBe("t1");
  });

  it("keeps the same xterm and its scrollback across unmount and remount", async () => {
    const first = render(pane("t2"));
    const xtermEl = document.querySelector(".xterm");
    output("t2")("before-switch\r\n");
    first.unmount();
    // Hidden threads keep receiving output into their buffer.
    output("t2")("while-hidden\r\n");
    render(pane("t2"));
    expect(document.querySelector(".xterm")).toBe(xtermEl);
    expect(ipc.ptyOpen).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screenText()).toContain("before-switch");
      expect(screenText()).toContain("while-hidden");
    });
  });

  it("Cmd+K clears the buffer without sending bytes", async () => {
    render(pane("t3"));
    output("t3")("old-line\r\n");
    await vi.waitFor(() => expect(screenText()).toContain("old-line"));
    const ev = press({ key: "k", code: "KeyK", keyCode: 75, metaKey: true });
    await vi.waitFor(() => expect(screenText()).not.toContain("old-line"));
    expect(ev.defaultPrevented).toBe(true);
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
  });

  it("Cmd+C copies a selection and otherwise sends nothing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(pane("t4"));
    output("t4")("copy-me\r\n");
    await vi.waitFor(() => expect(screenText()).toContain("copy-me"));

    press({ key: "c", code: "KeyC", keyCode: 67, metaKey: true });
    expect(writeText).not.toHaveBeenCalled();

    press({ key: "a", code: "KeyA", keyCode: 65, metaKey: true }); // select all
    press({ key: "c", code: "KeyC", keyCode: 67, metaKey: true });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("copy-me");
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
  });

  it("Option+B sends ESC b (Option as Meta) and Ctrl+R goes to the shell", async () => {
    render(pane("t5"));
    press({ key: "∫", code: "KeyB", keyCode: 66, altKey: true });
    press({ key: "r", code: "KeyR", keyCode: 82, ctrlKey: true });
    await vi.waitFor(() => expect(written()).toEqual(["\x1bb", "\x12"]));
  });

  it("Cmd+Left/Right send line start/end", async () => {
    render(pane("t6"));
    press({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, metaKey: true });
    press({ key: "ArrowRight", code: "ArrowRight", keyCode: 39, metaKey: true });
    await vi.waitFor(() => expect(written()).toEqual(["\x01", "\x05"]));
  });

  it("does not consume app shortcuts such as Cmd+N", () => {
    render(pane("t7"));
    const ev = press({ key: "n", code: "KeyN", keyCode: 78, metaKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
  });

  it("routes a native paste through xterm, with bracketed-paste markers when the shell asked", async () => {
    render(pane("t8"));
    output("t8")("\x1b[?2004h"); // shell enables bracketed paste
    await new Promise((r) => setTimeout(r, 20));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { getData: () => "line1\nline2" } });
    act(() => {
      textarea().dispatchEvent(paste);
    });
    await vi.waitFor(() => expect(written()).toEqual(["\x1b[200~line1\rline2\x1b[201~"]));
  });

  it("Cmd+F opens the find widget; Escape closes it", async () => {
    render(pane("t9"));
    press({ key: "f", code: "KeyF", keyCode: 70, metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull();
  });

  it("only the visible terminal holds a WebGL context", () => {
    const a = render(pane("w1"));
    expect(webgl.live()).toHaveLength(1);
    a.rerender(pane("w1", false));
    expect(webgl.live()).toHaveLength(0);
    a.rerender(pane("w1", true));
    expect(webgl.live()).toHaveLength(1);
    a.unmount();
    expect(webgl.live()).toHaveLength(0);
    render(pane("w2"));
    expect(webgl.live()).toHaveLength(1);
  });

  it("a pane first mounted hidden starts the shell, buffers output, and opens xterm once shown", async () => {
    const r = render(pane("h1", false));
    expect(ipc.ptyOpen).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".xterm")).toBeNull();
    expect(webgl.live()).toHaveLength(0);
    output("h1")("buffered-early\r\n");
    r.rerender(pane("h1", true));
    expect(document.querySelector(".xterm")).not.toBeNull();
    expect(webgl.live()).toHaveLength(1);
    await vi.waitFor(() => expect(screenText()).toContain("buffered-early"));
  });

  it("falls back to the DOM renderer after a WebGL context loss", async () => {
    render(pane("w3"));
    const [addon] = webgl.live();
    act(() => addon.loseContext());
    expect(addon.disposed).toBe(true);
    expect(webgl.live()).toHaveLength(0);
    output("w3")("still-rendering\r\n");
    await vi.waitFor(() => expect(screenText()).toContain("still-rendering"));
  });

  it("reports a shell exit and restarts the PTY on Enter", async () => {
    render(pane("x1"));
    // The registry subscribes to pty-exit once, with its first terminal.
    act(() => exitListener({ threadId: "x1", code: 0 }));
    await vi.waitFor(() => expect(screenText()).toContain("[Process exited with code 0]"));
    press({ key: "a", code: "KeyA", keyCode: 65 });
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
    expect(ipc.ptyOpen).toHaveBeenCalledTimes(1);
    press({ key: "Enter", code: "Enter", keyCode: 13 });
    expect(ipc.ptyOpen).toHaveBeenCalledTimes(2);
    expect(ipc.ptyOpen.mock.calls[1].slice(0, 2)).toEqual(["x1", "/proj/x1"]);
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
  });

  it("disposeTerminal closes the PTY and drops the instance", () => {
    const r = render(pane("d1"));
    r.unmount();
    disposeTerminal("d1");
    expect(ipc.ptyClose).toHaveBeenCalledWith("d1");
    render(pane("d1"));
    expect(ipc.ptyOpen).toHaveBeenCalledTimes(2);
  });
});

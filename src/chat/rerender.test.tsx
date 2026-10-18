// Streaming must not re-render the whole transcript: only the row (and markdown block) that changed.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent, RawMessage } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) =>
    // Host RPCs reach this fake by their method name, like the old commands.
    (cmd === "host_call" ? invoke((args as { method: string }).method, (args as { params: unknown }).params) : invoke(cmd, args)),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
// Every timeline row calls timelineClass once per render, so its call count is the render count.
vi.mock("./messages/timeline", async (importOriginal) => {
  const real = await importOriginal<typeof import("./messages/timeline")>();
  return { ...real, timelineClass: vi.fn(real.timelineClass) };
});

import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { __resetRuntimeForTests } from "../store/runtime";
import { Markdown } from "./markdown/Markdown";
import { timelineClass } from "./messages/timeline";
import { Transcript } from "./Transcript";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("transcript") ? 600 : 48;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const h = this.hasAttribute("data-index") ? 48 : 600;
    return { x: 0, y: 0, top: 0, left: 0, bottom: h, right: 800, width: 800, height: h, toJSON() {} } as DOMRect;
  };
});

let threadId = "";
let seq = 0;
const send = (...events: ClaudeEvent[]) =>
  act(() => {
    for (const e of events) useThreadStore.getState().dispatch(threadId, e);
  });
const m = (raw: RawMessage): ClaudeEvent => ({ kind: "message", seq: ++seq, raw });
const se = (event: Record<string, unknown>): ClaudeEvent => m({ type: "stream_event", event, parent_tool_use_id: null, api_message_id: "msg_s" });
const asst = (id: string, text: string): ClaudeEvent => m({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null });
const delta = (text: string) => se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false });
  threadId = useAppStore.getState().addProject("/work/proj");
  vi.mocked(timelineClass).mockClear();
});
afterEach(cleanup);

describe("Transcript re-rendering", () => {
  it("re-renders only the streaming row on a text delta", () => {
    render(<Transcript threadId={threadId} />);
    send(
      asst("a1", "first answer"),
      asst("a2", "second answer"),
      asst("a3", "third answer"),
      se({ type: "message_start", message: { id: "msg_s", content: [] } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      delta("Hel"),
    );
    expect(document.querySelectorAll("[data-block-kind='text']")).toHaveLength(4);

    vi.mocked(timelineClass).mockClear();
    send(delta("lo"));
    expect(timelineClass).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-block-kind='text']")[3]).toHaveTextContent("Hello");

    // A row whose neighbours change (its timeline position) does re-render.
    vi.mocked(timelineClass).mockClear();
    send(m({ type: "user", message: { role: "user", content: "next question" }, parent_tool_use_id: null }));
    expect(timelineClass).toHaveBeenCalledTimes(0);
    send(asst("a5", "after the question"));
    expect(timelineClass).toHaveBeenCalledTimes(1);
  });

  it("does not re-render the transcript for ignored events", () => {
    render(<Transcript threadId={threadId} />);
    send(asst("a1", "answer"));
    vi.mocked(timelineClass).mockClear();
    const before = useThreadStore.getState();
    send(m({ type: "keep_alive" }), m({ type: "system", subtype: "hook_started" }));
    expect(useThreadStore.getState()).toBe(before);
    expect(timelineClass).not.toHaveBeenCalled();
  });
});

describe("Markdown incremental rendering", () => {
  let urls = 0;
  const RealURL = URL;
  beforeEach(() => {
    urls = 0;
    // SafeLink validates hrefs with `new URL`, so constructions count link renders.
    globalThis.URL = class extends RealURL {
      constructor(url: string | URL, base?: string | URL) {
        super(url, base);
        urls++;
      }
    } as typeof URL;
  });
  afterEach(() => {
    globalThis.URL = RealURL;
  });

  it("re-renders only the tail block while text grows", () => {
    const head = "See [the docs](https://example.com/docs).\n\n";
    const { rerender, container } = render(<Markdown text={`${head}Streaming`} />);
    expect(urls).toBe(1);
    const firstP = container.querySelector("p");
    rerender(<Markdown text={`${head}Streaming more`} />);
    rerender(<Markdown text={`${head}Streaming more text`} />);
    expect(urls).toBe(1);
    expect(container.querySelector("p")).toBe(firstP);
    expect(container.querySelectorAll("p")[1]).toHaveTextContent("Streaming more text");
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com/docs");
  });

  it("re-renders earlier blocks when a later reference definition resolves their links", () => {
    const { rerender, container } = render(<Markdown text={"Read [the guide][g].\n\nmore"} />);
    expect(container.querySelector("a")).toBeNull();
    rerender(<Markdown text={"Read [the guide][g].\n\nmore\n\n[g]: https://example.com/guide"} />);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com/guide");
  });

  it("renders the same markup as before for a mixed document", () => {
    const text = "# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n<b>raw</b>\n\n![alt](https://e.com/i.png)";
    const { container } = render(<Markdown text={text} />);
    const md = container.querySelector(".md")!;
    expect([...md.children].map((c) => c.tagName)).toEqual(["H1", "UL", "TABLE", "BLOCKQUOTE", "P", "P"]);
    expect(md.querySelector("img")).toBeNull();
    expect(md.querySelector("b")).toBeNull();
    expect(md).toHaveTextContent("<b>raw</b>");
  });
});

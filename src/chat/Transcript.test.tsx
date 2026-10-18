import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent, RawMessage } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) =>
    // Host RPCs reach this fake by their method name.
    (cmd === "host_call" ? invoke((args as { method: string }).method, (args as { params: unknown }).params) : invoke(cmd, args)),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { __resetRuntimeForTests } from "../store/runtime";
import { resetUnknownTypeLog } from "../store/reducer";
import { syntheticSession } from "../test/fixtures/synthetic";
import { ChatPane } from "./ChatPane";
import { Transcript } from "./Transcript";

// jsdom has no layout: give the scroller a viewport and rows a height so the virtualizer can window.
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
const se = (event: Record<string, unknown>, msgId = "msg_1"): ClaudeEvent =>
  m({ type: "stream_event", event, parent_tool_use_id: null, api_message_id: msgId });
const asst = (content: unknown[], parent: string | null = null, id = "msg_1"): ClaudeEvent =>
  m({ type: "assistant", message: { id, role: "assistant", content }, parent_tool_use_id: parent });
const toolResult = (id: string, content: unknown, isError = false, parent: string | null = null): ClaudeEvent =>
  m({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: parent });
const status = (s: Extract<ClaudeEvent, { kind: "status" }>["status"], stderr: string | null = null): ClaudeEvent => ({
  kind: "status",
  seq: ++seq,
  status: s,
  detail: s === "crashed" ? "claude exited with code 1" : null,
  stderr_tail: stderr,
  reconnecting: false,
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_extension_settings") return { "claudeCode.showMessageTimestamps": false };
    if (cmd === "claude_retry") return "starting";
    return undefined;
  });
  __resetRuntimeForTests();
  resetUnknownTypeLog();
  useThreadStore.setState({ threads: {} });
  // This Mac is connected, as it is by the time a thread shows.
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false, hosts: [{ key: "local", state: { state: "connected", host_id: "this-mac", agent_version: "test" }, update: null }] });
  threadId = useAppStore.getState().addProject("/work/proj");
});
afterEach(cleanup);

describe("Transcript", () => {
  it("renders streamed text deltas as one growing block", () => {
    render(<Transcript threadId={threadId} />);
    send(
      se({ type: "message_start", message: { id: "msg_1", content: [] } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } }),
    );
    const blocks = document.querySelectorAll("[data-block-kind='text']");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveTextContent("Hello there");
  });

  it("moves one tool card from running to done with the result collapsed", () => {
    render(<Transcript threadId={threadId} />);
    send(asst([{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la" } }]));
    let cards = document.querySelectorAll("[data-block-kind='tool']");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute("data-status", "running");
    expect(cards[0]).toHaveTextContent("ls -la");

    send(toolResult("tu_1", "total 0\nfile-a"));
    cards = document.querySelectorAll("[data-block-kind='tool']");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute("data-status", "done");
    expect(within(cards[0] as HTMLElement).queryByText(/file-a/)).toBeNull();

    fireEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: /Bash/ }));
    expect(within(cards[0] as HTMLElement).getByText(/file-a/)).toBeInTheDocument();
  });

  it("renders an is_error tool result in the error state", () => {
    render(<Transcript threadId={threadId} />);
    send(asst([{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "touch x" } }]), toolResult("tu_1", "Permission denied", true));
    const card = document.querySelector("[data-block-kind='tool']")!;
    expect(card).toHaveAttribute("data-status", "error");
    expect(card.className).toMatch(/dot-failure/);
  });

  it("renders a TodoWrite todo list with statuses", () => {
    render(<Transcript threadId={threadId} />);
    send(
      asst([
        {
          type: "tool_use",
          id: "tu_t",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Write tests", status: "completed", activeForm: "Writing tests" },
              { content: "Implement", status: "in_progress", activeForm: "Implementing" },
              { content: "Ship", status: "pending", activeForm: "Shipping" },
            ],
          },
        },
      ]),
    );
    const items = document.querySelectorAll("[data-todo-status]");
    expect([...items].map((i) => [i.textContent, i.getAttribute("data-todo-status")])).toEqual([
      ["Write tests", "completed"],
      ["Implement", "in_progress"],
      ["Ship", "pending"],
    ]);
  });

  it("nests subagent progress under its Task card", () => {
    render(<Transcript threadId={threadId} />);
    send(
      asst([{ type: "tool_use", id: "task_1", name: "Task", input: { description: "Search the repo", prompt: "find x", subagent_type: "Explore" } }]),
      asst([{ type: "tool_use", id: "c1", name: "Grep", input: { pattern: "needle" } }], "task_1", "msg_c"),
    );
    const task = document.querySelector("[data-block-kind='tool'][data-tool-id='task_1']")!;
    expect(task).toHaveTextContent("Search the repo");
    const child = task.querySelector("[data-tool-id='c1']");
    expect(child).not.toBeNull();
    expect(child).toHaveTextContent("needle");
    // top level holds only the Task card
    expect(document.querySelectorAll(".transcript-row > [data-block-kind]")).toHaveLength(1);
  });

  it("renders thinking collapsed with its duration", () => {
    render(<Transcript threadId={threadId} />);
    send({ kind: "seed", lines: [{ type: "assistant", thinkingDurationMs: 4200, message: { id: "a", content: [{ type: "thinking", thinking: "secret plan" }] } }] } as never);
    const thinking = document.querySelector("[data-block-kind='thinking']")!;
    expect(thinking).toHaveTextContent("Thought for 4s");
    expect(within(thinking as HTMLElement).queryByText("secret plan")).toBeNull();
    fireEvent.click(within(thinking as HTMLElement).getByRole("button"));
    expect(within(thinking as HTMLElement).getByText("secret plan")).toBeInTheDocument();
  });

  it("renders nothing for an unknown message type, logs once, and still renders later messages", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    render(<Transcript threadId={threadId} />);
    send(m({ type: "mystery_type" }), m({ type: "mystery_type" }), asst([{ type: "text", text: "after the mystery" }]));
    expect(document.querySelectorAll(".transcript-row")).toHaveLength(1);
    expect(screen.getByText("after the mystery")).toBeInTheDocument();
    expect(debug.mock.calls.filter((c) => String(c[0]).includes("mystery_type"))).toHaveLength(1);
    debug.mockRestore();
  });

  it("virtualizes a 2,000-message session: only a bounded window of rows is in the DOM", () => {
    const actions = syntheticSession(2000);
    const t0 = performance.now();
    act(() => {
      for (const a of actions) useThreadStore.getState().dispatch(threadId, a);
    });
    expect(performance.now() - t0).toBeLessThan(1000);
    const total = useThreadStore.getState().threads[threadId].blocks.length;
    expect(total).toBeGreaterThan(1000);
    render(<Transcript threadId={threadId} />);
    const rows = document.querySelectorAll(".transcript-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
  });
});

describe("Transcript scroll position across resizes", () => {
  // The scroller's geometry, driven by the test; a ResizeObserver stub fires on demand.
  let view = { clientHeight: 600, scrollHeight: 3000, scrollTop: 0 };
  const observers = new Set<{ fire(t: HTMLElement): void }>();
  const restore: (() => void)[] = [];

  beforeEach(() => {
    view = { clientHeight: 600, scrollHeight: 3000, scrollTop: 0 };
    for (const key of ["clientHeight", "scrollHeight", "scrollTop"] as const) {
      const prev = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key) ?? Object.getOwnPropertyDescriptor(Element.prototype, key)!;
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("transcript") ? view[key] : prev.get?.call(this);
        },
        set(this: HTMLElement, v: number) {
          if (this.classList.contains("transcript")) view[key] = Math.max(0, Math.min(v, view.scrollHeight - view.clientHeight));
          else prev.set?.call(this, v);
        },
      });
      restore.push(() => delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]);
    }
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets = new Set<Element>();
        constructor(private cb: ResizeObserverCallback) {
          observers.add(this);
        }
        observe(t: Element) {
          this.targets.add(t);
        }
        unobserve(t: Element) {
          this.targets.delete(t);
        }
        disconnect() {
          observers.delete(this);
        }
        fire(t: HTMLElement) {
          if (!this.targets.has(t)) return;
          const size = { inlineSize: 800, blockSize: view.clientHeight };
          const entry = { target: t, contentRect: { width: 800, height: view.clientHeight }, borderBoxSize: [size], contentBoxSize: [size] };
          this.cb([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
      },
    );
  });
  afterEach(() => {
    observers.clear();
    for (const r of restore.splice(0)) r();
    vi.unstubAllGlobals();
  });

  const scroller = () => document.querySelector(".transcript") as HTMLElement;
  const scrollTo = (top: number) => {
    view.scrollTop = top;
    fireEvent.scroll(scroller());
  };
  const resize = (clientHeight: number) => {
    view.clientHeight = clientHeight;
    view.scrollTop = Math.min(view.scrollTop, Math.max(0, view.scrollHeight - clientHeight));
    act(() => {
      for (const o of observers) o.fire(scroller());
    });
  };

  it("keeps the distance from the bottom when the terminal opens and closes", () => {
    render(<Transcript threadId={threadId} />);
    scrollTo(1000); // 1,400 px above the bottom
    resize(400); // terminal opens
    expect(view.scrollTop).toBe(3000 - 400 - 1400);
    resize(600); // and closes
    expect(view.scrollTop).toBe(1000);
  });

  it("stays at the bottom when it was there", () => {
    render(<Transcript threadId={threadId} />);
    scrollTo(2400);
    resize(400);
    expect(view.scrollTop).toBe(2600);
  });

  it("restores the position after being hidden while the terminal is maximized", () => {
    render(<Transcript threadId={threadId} />);
    scrollTo(1000);
    resize(0);
    scrollTo(0); // hiding resets scrollTop
    expect(view.scrollTop).toBe(0);
    resize(400); // restored next to the terminal
    expect(view.scrollTop).toBe(3000 - 400 - 1400);
  });
});

describe("Markdown safety", () => {
  it("renders raw HTML in assistant text as literal text", () => {
    render(<Transcript threadId={threadId} />);
    send(asst([{ type: "text", text: "look: <img src=x onerror=alert(1)> and <script>alert(2)</script>" }]));
    const block = document.querySelector("[data-block-kind='text']")!;
    expect(block.querySelector("img")).toBeNull();
    expect(block.querySelector("script")).toBeNull();
    expect(block).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("makes javascript: links inert and opens http(s) links via open_path", async () => {
    render(<Transcript threadId={threadId} />);
    send(asst([{ type: "text", text: "[bad](javascript:alert(1)) and [good](https://example.com/x)" }]));
    const block = document.querySelector("[data-block-kind='text']")!;
    const anchors = [...block.querySelectorAll("a")];
    expect(anchors.map((a) => a.textContent)).toEqual(["good"]);
    expect(block).toHaveTextContent("bad");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchors[0].dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_path", { path: "https://example.com/x" }));
  });
});

describe("ChatPane", () => {
  it("shows the crash card with stderr, retries via claude_retry, and drops the card once idle", async () => {
    render(<ChatPane threadId={threadId} />);
    send(status("crashed", "Error: segfault in widget\nat line 3"));
    const card = await screen.findByRole("alert");
    expect(card).toHaveTextContent("claude exited with code 1");
    fireEvent.click(within(card).getByRole("button", { name: /stderr/i }));
    expect(within(card).getByText(/segfault in widget/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_retry", { threadId }));
    await waitFor(() => expect(useThreadStore.getState().threads[threadId].status).toBe("starting"));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    send(status("idle"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a reconnecting state while the automatic respawn runs", () => {
    render(<ChatPane threadId={threadId} />);
    send({ kind: "status", seq: ++seq, status: "starting", detail: null, stderr_tail: "x", reconnecting: true });
    expect(screen.getByRole("alert")).toHaveTextContent(/Reconnecting/);
  });

  it("renders pending permission cards inline and seeds a resumed thread from its session file", async () => {
    useAppStore.getState().updateThread(threadId, { sessionId: "s-1" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_load") return [{ type: "user", uuid: "u1", message: { role: "user", content: "earlier question" } }];
      return {};
    });
    render(<ChatPane threadId={threadId} />);
    expect(await screen.findByText("earlier question")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("session_load", { projectPath: "/work/proj", sessionId: "s-1" });

    send({ kind: "permission_request", seq: ++seq, request_id: "r9", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} }, diff: null });
    expect(document.querySelector(".permission-card[data-request='r9']")).not.toBeNull();
  });

  it("shows a non-blocking notice when the session file cannot be loaded", async () => {
    useAppStore.getState().updateThread(threadId, { sessionId: "s-gone" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_load") throw new Error("not found");
      return {};
    });
    render(<ChatPane threadId={threadId} />);
    expect(await screen.findByText(/Couldn't load earlier messages/)).toBeInTheDocument();
  });

  it("opens a new thread from the New conversation button instead of rebinding this one", () => {
    render(<ChatPane threadId={threadId} />);
    fireEvent.click(screen.getByRole("button", { name: /new conversation/i }));
    const threads = useAppStore.getState().projects[0].threads;
    expect(threads).toHaveLength(2);
    expect(useAppStore.getState().selectedThreadId).toBe(threads[1].id);
  });

  it("shows the spinner with a verb while working, honoring custom spinner verbs", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "get_extension_settings" ? { "claudeCode.spinnerVerbs": { mode: "replace", verbs: ["Speedrunning"] } } : undefined,
    );
    render(<ChatPane threadId={threadId} />);
    send(status("working"));
    expect(await screen.findByText(/Speedrunning/)).toBeInTheDocument();
  });

  it("keeps the spinner up with an agent count while background agents outlive the turn", async () => {
    render(<ChatPane threadId={threadId} />);
    const tasks = [
      { task_id: "a", task_type: "local_agent", description: "Research" },
      { task_id: "b", task_type: "local_agent", description: "Review" },
    ];
    send(status("working"), m({ type: "system", subtype: "background_tasks_changed", tasks }));
    expect(await screen.findByText(/2 agents running/)).toBeInTheDocument();
    send(m({ type: "result", subtype: "success", is_error: false }), status("idle"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 agents running in the background"));
    send(m({ type: "system", subtype: "background_tasks_changed", tasks: [] }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});

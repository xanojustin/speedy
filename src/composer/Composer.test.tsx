import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent, RawMessage, ThreadStatus } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { findThread, useAppStore } from "../store/appStore";
import { __resetRuntimeForTests } from "../store/runtime";
import { useThreadStore } from "../store/threadStore";
import { Composer } from "./Composer";
import { __resetSessionControlsForTests } from "./sessionControls";

let threadId = "";
let seq = 0;
let settings: Record<string, unknown> = {};
/** Per-command overrides for the invoke mock. */
let handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

const dispatch = (...events: ClaudeEvent[]) =>
  act(() => {
    for (const e of events) useThreadStore.getState().dispatch(threadId, e);
  });
const status = (s: ThreadStatus): ClaudeEvent => ({ kind: "status", seq: ++seq, status: s, detail: null, stderr_tail: null, reconnecting: false });
const msg = (raw: RawMessage): ClaudeEvent => ({ kind: "message", seq: ++seq, raw });
const initialized = (response: Record<string, unknown>): ClaudeEvent => ({ kind: "initialized", seq: ++seq, response });
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>);
const controlCalls = (subtype: string) => calls("claude_control").filter((a) => (a.request as { subtype: string }).subtype === subtype);
const thread = () => findThread(useAppStore.getState(), threadId)!.thread;

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Opus for complex work", resolvedModel: "claude-opus-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "sonnet", displayName: "Sonnet", description: "Everyday tasks", resolvedModel: "claude-sonnet-5" },
  { value: "haiku", displayName: "Haiku", description: "Fastest" },
];

/** A running session: initialize answered, system/init seen, idle. */
function goLive(extra: Record<string, unknown> = {}) {
  dispatch(
    initialized({ commands: [], models: MODELS, current_permission_mode: "default", ...extra }),
    msg({ type: "system", subtype: "init", model: "claude-opus-5", permissionMode: "default", slash_commands: [] }),
    status("idle"),
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function renderComposer() {
  const user = userEvent.setup();
  const view = render(<Composer threadId={threadId} />);
  // Let the extension-settings read resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
  return { user, input, ...view };
}

beforeEach(() => {
  seq = 0;
  settings = {
    "claudeCode.useCtrlEnterToSend": false,
    "claudeCode.respectGitIgnore": true,
    "claudeCode.allowDangerouslySkipPermissions": false,
    "claudeCode.initialPermissionMode": "default",
  };
  handlers = {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (handlers[cmd]) return handlers[cmd](args);
    if (cmd === "get_extension_settings") return settings;
    if (cmd === "claude_start") return "idle";
    if (cmd === "files_search") return [];
    return undefined;
  });
  __resetRuntimeForTests();
  __resetSessionControlsForTests();
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false });
  threadId = useAppStore.getState().addProject("/work/proj");
});

afterEach(() => cleanup());

describe("sending", () => {
  it("Enter sends and Shift+Enter inserts a newline", async () => {
    const { user, input } = await renderComposer();
    await user.type(input, "first{Shift>}{Enter}{/Shift}second");
    expect(input.value).toBe("first\nsecond");
    expect(calls("claude_send_user")).toHaveLength(0);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls("claude_send_user")).toHaveLength(1));
    expect(calls("claude_send_user")[0].content).toEqual([{ type: "text", text: "first\nsecond" }]);
    expect(input.value).toBe("");
  });

  it("with useCtrlEnterToSend, Enter inserts a newline and Cmd/Ctrl+Enter sends", async () => {
    settings["claudeCode.useCtrlEnterToSend"] = true;
    const { user, input } = await renderComposer();
    await user.type(input, "line one{Enter}line two");
    expect(input.value).toBe("line one\nline two");
    expect(calls("claude_send_user")).toHaveLength(0);

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(calls("claude_send_user")).toHaveLength(1));
    expect(calls("claude_send_user")[0].content).toEqual([{ type: "text", text: "line one\nline two" }]);

    await user.type(input, "again");
    await user.keyboard("{Control>}{Enter}{/Control}");
    // The first turn is still running, so the runtime queues this one.
    await waitFor(() => expect(useThreadStore.getState().threads[threadId].queue.map((q) => q.content)).toEqual([[{ type: "text", text: "again" }]]));
    expect(input.value).toBe("");
  });

  it("does not send an empty message", async () => {
    const { user, input } = await renderComposer();
    await user.type(input, "   {Enter}");
    expect(calls("claude_send_user")).toHaveLength(0);
  });

  it("focuses on mount and on a matching speedy:focus-composer event", async () => {
    const { input } = await renderComposer();
    expect(document.activeElement).toBe(input);
    input.blur();
    act(() => void window.dispatchEvent(new CustomEvent("speedy:focus-composer", { detail: { threadId: "other" } })));
    expect(document.activeElement).not.toBe(input);
    act(() => void window.dispatchEvent(new CustomEvent("speedy:focus-composer", { detail: { threadId } })));
    expect(document.activeElement).toBe(input);
  });
});

describe("slash menu", () => {
  it("before the session starts it shows a hint, not an invented list", async () => {
    const { user, input } = await renderComposer();
    await user.type(input, "/");
    const menu = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(menu).queryAllByRole("option")).toHaveLength(0);
    expect(menu).toHaveTextContent(/start/i);
  });

  it("filters initialize commands plus system/init slash_commands by prefix and inserts the selection", async () => {
    dispatch(
      initialized({
        commands: [
          { name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" },
          { name: "context", description: "Show context usage", argumentHint: "" },
          { name: "review", description: "Review a pull request", argumentHint: "" },
        ],
        models: MODELS,
      }),
      msg({ type: "system", subtype: "init", slash_commands: ["compact", "custom-skill"] }),
      status("idle"),
    );
    const { user, input } = await renderComposer();
    await user.type(input, "/co");
    const menu = screen.getByRole("listbox", { name: "Slash commands" });
    const names = within(menu).getAllByRole("option").map((o) => o.querySelector(".slash-name")?.textContent);
    expect(names).toEqual(["/compact", "/context"]);
    expect(menu).toHaveTextContent("Clear history but keep a summary");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(input.value).toBe("/context ");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();
    expect(calls("claude_send_user")).toHaveLength(0);

    await user.clear(input);
    await user.type(input, "/cu");
    const opts = within(screen.getByRole("listbox", { name: "Slash commands" })).getAllByRole("option");
    expect(opts.map((o) => o.querySelector(".slash-name")?.textContent)).toEqual(["/custom-skill"]);
    await user.keyboard("{Tab}");
    expect(input.value).toBe("/custom-skill ");
  });
});

describe("@-mentions", () => {
  it("searches files for the typed query (respectGitIgnore passed through) and inserts the selected path", async () => {
    settings["claudeCode.respectGitIgnore"] = false;
    handlers.files_search = () => [
      { path: "src/main.rs", isDir: false },
      { path: "src/manifest.json", isDir: false },
    ];
    const { user, input } = await renderComposer();
    await user.type(input, "look at @src/ma");
    const menu = await screen.findByRole("listbox", { name: "Files" });
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(2));
    const last = calls("files_search").at(-1)!;
    expect(last).toEqual({ root: "/work/proj", query: "src/ma", limit: 50, respectGitignore: false });

    await user.keyboard("{Enter}");
    expect(input.value).toBe("look at @src/main.rs ");
    expect(screen.queryByRole("listbox", { name: "Files" })).toBeNull();
    expect(calls("claude_send_user")).toHaveLength(0);
  });
});

describe("images", () => {
  it("pasting a PNG attaches a thumbnail and sending includes a base64 image block", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], "shot.png", { type: "image/png" });
    const { user, input } = await renderComposer();
    fireEvent.paste(input, {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" },
    });
    const thumb = await screen.findByRole("img", { name: "shot.png" });
    expect(thumb.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    await user.type(input, "what is this{Enter}");
    await waitFor(() => expect(calls("claude_send_user")).toHaveLength(1));
    expect(calls("claude_send_user")[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: btoa(String.fromCharCode(...bytes)) } },
      { type: "text", text: "what is this" },
    ]);
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
  });

  it("an attached image can be removed before sending", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const { user, input } = await renderComposer();
    fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" } });
    await screen.findByRole("img", { name: "a.png" });
    await user.click(screen.getByRole("button", { name: "Remove a.png" }));
    expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();
  });
});

describe("queue and interrupt", () => {
  it("messages sent while working are queued and shown; removing one drops it from the queue", async () => {
    goLive();
    dispatch(status("working"));
    const { user, input } = await renderComposer();
    expect(input).toHaveAttribute("placeholder", "Queue another message…");
    await user.type(input, "one{Enter}");
    await user.type(input, "two{Enter}");
    const queue = await screen.findByRole("list", { name: "Queued messages" });
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(2));
    expect(within(queue).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(calls("claude_send_user")).toHaveLength(0);

    await user.click(within(queue).getAllByRole("button", { name: "Remove queued message" })[0]);
    expect(useThreadStore.getState().threads[threadId].queue.map((q) => q.content)).toEqual([[{ type: "text", text: "two" }]]);
    expect(within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["two"]);
  });

  it("Esc while working interrupts; Esc while idle does nothing", async () => {
    goLive();
    const { user, input } = await renderComposer();
    await user.type(input, "{Escape}");
    expect(calls("claude_interrupt")).toHaveLength(0);

    dispatch(status("working"));
    await user.type(input, "{Escape}");
    expect(calls("claude_interrupt")).toHaveLength(1);

    dispatch(status("awaiting_user"));
    await user.type(input, "{Escape}");
    expect(calls("claude_interrupt")).toHaveLength(2);
  });

  it("a stop button replaces send while working with an empty input", async () => {
    goLive();
    const { user } = await renderComposer();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    dispatch(status("working"));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(calls("claude_interrupt")).toHaveLength(1);
  });
});

describe("permission mode", () => {
  const modeButton = () => screen.getByRole("button", { name: /^Mode:/ });

  it("switching to plan sends set_permission_mode and the chip changes only after the CLI acknowledges", async () => {
    goLive();
    const ack = deferred<unknown>();
    handlers.claude_control = () => ack.promise;
    const { user } = await renderComposer();
    expect(modeButton()).toHaveAttribute("data-mode", "default");
    expect(modeButton()).toHaveTextContent("Manual");

    await user.click(modeButton());
    await user.click(screen.getByRole("menuitemradio", { name: /^Plan/ }));
    expect(controlCalls("set_permission_mode").map((a) => a.request)).toEqual([{ subtype: "set_permission_mode", mode: "plan" }]);
    // Pending: still the old mode.
    expect(modeButton()).toHaveAttribute("data-mode", "default");
    expect(modeButton()).toHaveTextContent("Manual");
    expect(thread().permissionMode).toBeNull();

    await act(async () => ack.resolve({}));
    await waitFor(() => expect(modeButton()).toHaveAttribute("data-mode", "plan"));
    expect(modeButton()).toHaveTextContent("Plan");
    expect(thread().permissionMode).toBe("plan");
  });

  it("a failed set_permission_mode leaves the chip on the old mode", async () => {
    goLive();
    handlers.claude_control = () => Promise.reject(new Error("rejected"));
    const { user } = await renderComposer();
    await user.click(modeButton());
    await user.click(screen.getByRole("menuitemradio", { name: /^Plan/ }));
    await act(async () => {});
    expect(modeButton()).toHaveAttribute("data-mode", "default");
    expect(thread().permissionMode).toBeNull();
  });

  it("Shift+Tab cycles modes through the CLI", async () => {
    goLive();
    handlers.claude_control = () => ({});
    const { user, input } = await renderComposer();
    await user.type(input, "{Shift>}{Tab}{/Shift}");
    expect(controlCalls("set_permission_mode").map((a) => (a.request as { mode: string }).mode)).toEqual(["acceptEdits"]);
    await waitFor(() => expect(modeButton()).toHaveAttribute("data-mode", "acceptEdits"));
  });

  it("before the session starts, picking a mode only persists it for the spawn", async () => {
    const { user } = await renderComposer();
    await user.click(modeButton());
    await user.click(screen.getByRole("menuitemradio", { name: /^Edit automatically/ }));
    expect(calls("claude_control")).toHaveLength(0);
    expect(thread().permissionMode).toBe("acceptEdits");
    expect(modeButton()).toHaveAttribute("data-mode", "acceptEdits");
  });

  it("a new thread starts in claudeCode.initialPermissionMode", async () => {
    settings["claudeCode.initialPermissionMode"] = "plan";
    await renderComposer();
    await waitFor(() => expect(thread().permissionMode).toBe("plan"));
    expect(modeButton()).toHaveAttribute("data-mode", "plan");
  });

  it("bypass is only offered when allowDangerouslySkipPermissions is on", async () => {
    goLive();
    handlers.claude_control = () => ({});
    const first = await renderComposer();
    await first.user.click(modeButton());
    expect(screen.queryByRole("menuitemradio", { name: /^Bypass permissions/ })).toBeNull();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    // Cycling from plan wraps to default instead of reaching bypass.
    await first.user.click(screen.getByRole("menuitemradio", { name: /^Plan/ }));
    await waitFor(() => expect(modeButton()).toHaveAttribute("data-mode", "plan"));
    await first.user.type(first.input, "{Shift>}{Tab}{/Shift}");
    expect(controlCalls("set_permission_mode").at(-1)!.request).toEqual({ subtype: "set_permission_mode", mode: "default" });
    first.unmount();

    settings["claudeCode.allowDangerouslySkipPermissions"] = true;
    const second = await renderComposer();
    await second.user.click(modeButton());
    await second.user.click(screen.getByRole("menuitemradio", { name: /^Bypass permissions/ }));
    expect(controlCalls("set_permission_mode").at(-1)!.request).toEqual({ subtype: "set_permission_mode", mode: "bypassPermissions" });
  });
});

describe("model and effort", () => {
  const modelButton = () => screen.getByRole("combobox", { name: /^Model/ });

  it("selecting a model sends set_model, then persists it on the thread", async () => {
    goLive();
    const ack = deferred<unknown>();
    handlers.claude_control = () => ack.promise;
    const { user } = await renderComposer();
    expect(modelButton()).toHaveTextContent("Default (recommended)");
    await user.click(modelButton());
    await user.click(screen.getByRole("option", { name: /^Sonnet/ }));
    expect(controlCalls("set_model").map((a) => a.request)).toEqual([{ subtype: "set_model", model: "sonnet" }]);
    expect(thread().model).toBeNull();
    await act(async () => ack.resolve({}));
    await waitFor(() => expect(thread().model).toBe("sonnet"));
    expect(modelButton()).toHaveTextContent("Sonnet");
  });

  it("before the session runs, selecting a model only persists it", async () => {
    goLive();
    dispatch(status("stopped"));
    const { user } = await renderComposer();
    await user.click(modelButton());
    await user.click(screen.getByRole("option", { name: /^Haiku/ }));
    expect(calls("claude_control")).toHaveLength(0);
    expect(thread().model).toBe("haiku");
  });

  it("effort levels from the model are set with apply_flag_settings", async () => {
    goLive();
    handlers.claude_control = () => ({});
    const { user } = await renderComposer();
    await user.click(screen.getByRole("button", { name: /^Mode:/ }));
    await user.click(screen.getByRole("radio", { name: "High" }));
    expect(controlCalls("apply_flag_settings").map((a) => a.request)).toEqual([{ subtype: "apply_flag_settings", settings: { effortLevel: "high" } }]);
    await waitFor(() => expect(modelButton()).toHaveTextContent("High"));
  });
});

describe("context usage", () => {
  it("is requested after each result and rendered", async () => {
    goLive();
    handlers.claude_control = (args) =>
      (args.request as { subtype: string }).subtype === "get_context_usage" ? { percentage: 72, totalTokens: 144000, maxTokens: 200000, categories: [] } : {};
    await renderComposer();
    expect(controlCalls("get_context_usage")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /context used/ })).toBeNull();

    dispatch(status("working"), msg({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1" }), status("idle"));
    await waitFor(() => expect(controlCalls("get_context_usage")).toHaveLength(1));
    const indicator = await screen.findByRole("button", { name: /72% context used/ });
    expect(indicator).toHaveAttribute("title", expect.stringContaining("28% of context remaining"));
  });
});

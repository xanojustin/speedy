import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanUseToolRequest, FileDiff, PermissionOutcome } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { __resetRuntimeForTests } from "../store/runtime";
import { PermissionCard } from "./PermissionCard";
import { DENY_MESSAGE, KEEP_PLANNING_MESSAGE, REJECT_WITH_REASON_PREFIX } from "./results";

let threadId = "";
let seq = 0;
let settings: Record<string, unknown> = {};
let outcomes: PermissionOutcome[] = [];

const respondCalls = () => invoke.mock.calls.filter((c) => c[0] === "claude_respond_permission").map((c) => c[1]);

function addRequest(request: Partial<CanUseToolRequest> & { tool_name: string }, diff: FileDiff[] | null = null, id = "req-1", tid = threadId) {
  act(() => {
    useThreadStore.getState().dispatch(tid, {
      kind: "permission_request",
      seq: ++seq,
      request_id: id,
      request: { subtype: "can_use_tool", input: {}, ...request } as CanUseToolRequest,
      diff,
    });
  });
}

const fileDiff = (path: string, unified: string, isNewFile = false, baseFingerprint = "fp1"): FileDiff => ({
  path,
  isNewFile,
  unified,
  baseFingerprint,
});

/** Visible diff rows as "<sign><text>" strings, e.g. "-old", "+new", " ctx". */
function diffRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".perm-diff-line")).map((row) => {
    const sign = row.dataset.kind === "add" ? "+" : row.dataset.kind === "del" ? "-" : " ";
    return sign + (row.querySelector(".perm-diff-code")?.textContent ?? "");
  });
}

beforeEach(() => {
  invoke.mockReset();
  settings = {};
  outcomes = [];
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_extension_settings") return settings;
    if (cmd === "claude_respond_permission") return outcomes.shift() ?? { sent: true, refreshedDiff: null };
    return undefined;
  });
  __resetRuntimeForTests();
  useThreadStore.setState({ threads: {} });
  useAppStore.setState({ projects: [], selectedThreadId: null, loaded: false });
  threadId = useAppStore.getState().addProject("/work/proj");
});

afterEach(() => cleanup());

const card = (tid = threadId, rid = "req-1") => render(<PermissionCard threadId={tid} requestId={rid} />);

describe("file edit diffs", () => {
  it("an Edit request renders exactly the replacement's -/+ lines", () => {
    addRequest(
      { tool_name: "Edit", display_name: "Edit", input: { file_path: "/work/proj/a.txt", old_string: "two", new_string: "TWO" } },
      [fileDiff("/work/proj/a.txt", "--- /work/proj/a.txt\n+++ /work/proj/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n")],
    );
    const { container } = card();
    expect(screen.getByText(/Make this edit to/)).toHaveTextContent("Make this edit to a.txt?");
    expect(diffRows(container)).toEqual([" one", "-two", "+TWO", " three"]);
    expect(container.querySelectorAll(".perm-diff-line[data-kind='add']")).toHaveLength(1);
    expect(container.querySelectorAll(".perm-diff-line[data-kind='del']")).toHaveLength(1);
    // Line numbers: the removed line is old line 2, the added line is new line 2.
    const del = container.querySelector<HTMLElement>(".perm-diff-line[data-kind='del']")!;
    expect(del.querySelector(".perm-diff-old")).toHaveTextContent("2");
    expect(del.querySelector(".perm-diff-new")).toHaveTextContent("");
  });

  it("a Write request for a new file shows an all-additions diff labeled 'new file'", () => {
    addRequest(
      { tool_name: "Write", input: { file_path: "/work/proj/new.txt", content: "a\nb\n" } },
      [fileDiff("/work/proj/new.txt", "--- /work/proj/new.txt\n+++ /work/proj/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n", true, "absent")],
    );
    const { container } = card();
    expect(screen.getByText("new file")).toBeInTheDocument();
    expect(diffRows(container)).toEqual(["+a", "+b"]);
  });

  it("a Write overwriting a file shows the full diff", () => {
    addRequest(
      { tool_name: "Write", input: { file_path: "/work/proj/b.txt", content: "x\ny\n" } },
      [fileDiff("/work/proj/b.txt", "--- /work/proj/b.txt\n+++ /work/proj/b.txt\n@@ -1,2 +1,2 @@\n-old1\n-old2\n+x\n+y\n")],
    );
    const { container } = card();
    expect(screen.queryByText("new file")).not.toBeInTheDocument();
    expect(screen.getByText(/Allow write to/)).toHaveTextContent("Allow write to b.txt?");
    expect(diffRows(container)).toEqual(["-old1", "-old2", "+x", "+y"]);
  });

  it("syntax-highlights diff lines by file extension without changing their text", async () => {
    addRequest({ tool_name: "Edit", input: { file_path: "/p/x.ts" } }, [
      fileDiff("/p/x.ts", "--- x\n+++ x\n@@ -1,2 +1,2 @@\n const a = 1;\n-let b = \"x\";\n+let b = \"y\";\n"),
    ]);
    const { container } = card();
    await waitFor(() => expect(container.querySelectorAll(".perm-diff-code.shiki-line")).toHaveLength(3), { timeout: 5000 });
    expect(container.querySelector(".perm-diff-code.shiki-line span")).not.toBeNull();
    expect(diffRows(container)).toEqual([" const a = 1;", '-let b = "x";', '+let b = "y";']);
  });

  it("shows a 'file too large' summary as-is", () => {
    const summary = "(file too large to show a diff: 5000000 bytes → 5000001 bytes)";
    addRequest({ tool_name: "Write", input: { file_path: "/p/big.log", content: "…" } }, [
      fileDiff("/p/big.log", `--- /p/big.log\n+++ /p/big.log\n${summary}\n`),
    ]);
    const { container } = card();
    expect(screen.getByText(summary)).toBeInTheDocument();
    expect(diffRows(container)).toEqual([]);
  });

  it("accept on a stale diff refreshes it, shows the notice, keeps the card; a second accept sends", async () => {
    const input = { file_path: "/work/proj/a.txt", old_string: "two", new_string: "TWO" };
    addRequest({ tool_name: "Edit", input }, [
      fileDiff("/work/proj/a.txt", "--- a\n+++ a\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n"),
    ]);
    outcomes.push({
      sent: false,
      refreshedDiff: [fileDiff("/work/proj/a.txt", "--- a\n+++ a\n@@ -1,2 +1,2 @@\n ONE-CHANGED\n-two\n+TWO\n", false, "fp2")],
    });
    const { container } = card();
    fireEvent.click(screen.getByRole("button", { name: /^1\s*Yes$/ }));

    expect(await screen.findByText(/The file changed since this diff was shown/)).toBeInTheDocument();
    expect(diffRows(container)).toEqual([" ONE-CHANGED", "-two", "+TWO"]);
    expect(useThreadStore.getState().threads[threadId].pendingPermissions).toHaveLength(1);
    expect(respondCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^1\s*Yes$/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(2));
    expect(respondCalls()[1]).toEqual({ threadId, requestId: "req-1", response: { behavior: "allow", updatedInput: input } });
    await waitFor(() => expect(container.querySelector(".perm-card")).toBeNull());
  });

  it("multi-file requests need every file accepted; rejecting any file denies", async () => {
    addRequest({ tool_name: "MultiEdit", input: { file_path: "/p/a.txt" } }, [
      fileDiff("/p/a.txt", "--- a\n+++ a\n@@ -1 +1 @@\n-a\n+A\n"),
      fileDiff("/p/b.txt", "--- b\n+++ b\n@@ -1 +1 @@\n-b\n+B\n"),
    ]);
    card();
    const allow = screen.getByRole("button", { name: /^1\s*Yes$/ });
    expect(allow).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept a.txt" }));
    expect(allow).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept b.txt" }));
    expect(allow).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Reject b.txt" }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toMatchObject({ behavior: "deny" });
    expect(respondCalls()[0].response.message).toContain("/p/b.txt");
  });
});

describe("generic prompt choices", () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" },
    { type: "setMode", mode: "bypassPermissions", destination: "session" },
  ] as CanUseToolRequest["permission_suggestions"];

  it("always-allow shows where the rule is saved and sends the CLI's updates without a bypass setMode", async () => {
    const input = { command: "npm test", description: "Run tests" };
    addRequest({ tool_name: "Bash", input, permission_suggestions: suggestions });
    card();
    const always = screen.getByRole("button", { name: /^2\s*Yes, allow npm test for/ });
    expect(always).toHaveTextContent("this project (local, .claude/settings.local.json)");
    expect(screen.getByText(/every thread in this folder and VS Code/)).toBeInTheDocument();
    fireEvent.click(always);
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [suggestions![0]],
    });
  });

  it("keeps a bypass setMode when claudeCode.allowDangerouslySkipPermissions is on", async () => {
    settings = { "claudeCode.allowDangerouslySkipPermissions": true };
    addRequest({ tool_name: "Bash", input: { command: "npm test" }, permission_suggestions: suggestions });
    card();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_extension_settings", undefined));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^2\s*Yes, allow/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response.updatedPermissions).toEqual(suggestions);
  });

  it("shows each destination label", () => {
    addRequest({
      tool_name: "Read",
      input: { file_path: "/etc/hosts" },
      permission_suggestions: [
        { type: "addDirectories", directories: ["/etc"], destination: "userSettings" },
        { type: "addRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "projectSettings" },
        { type: "addRules", rules: [{ toolName: "Glob" }], behavior: "allow", destination: "session" },
      ],
    });
    card();
    const always = screen.getByRole("button", { name: /^2/ });
    expect(always).toHaveTextContent("all projects (~/.claude/settings.json)");
    expect(always).toHaveTextContent("this project (shared, .claude/settings.json)");
    expect(always).toHaveTextContent("this session only");
  });

  it("deny with typed feedback sends a deny carrying the message", async () => {
    addRequest({ tool_name: "Bash", input: { command: "rm -rf build" } });
    card();
    const feedback = screen.getByPlaceholderText("Tell Claude what to do instead");
    fireEvent.change(feedback, { target: { value: "use make clean" } });
    fireEvent.keyDown(feedback, { key: "Enter" });
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({
      behavior: "deny",
      message: `${REJECT_WITH_REASON_PREFIX} use make clean`,
      interrupt: false,
    });
  });

  it("deny without feedback sends the default message and interrupts", async () => {
    addRequest({ tool_name: "Bash", input: { command: "ls" } });
    card();
    fireEvent.click(screen.getByRole("button", { name: /^2\s*No$/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({ behavior: "deny", message: DENY_MESSAGE, interrupt: true });
  });

  it("keyboard: 1 allows once, Escape denies", async () => {
    addRequest({ tool_name: "Bash", input: { command: "ls" } });
    const { container } = card();
    fireEvent.keyDown(container.querySelector(".perm-card")!, { key: "1" });
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });

    cleanup();
    addRequest({ tool_name: "Bash", input: { command: "pwd" } }, null, "req-2");
    const second = card(threadId, "req-2");
    fireEvent.keyDown(second.container.querySelector(".perm-card")!, { key: "Escape" });
    await waitFor(() => expect(respondCalls()).toHaveLength(2));
    expect(respondCalls()[1]).toMatchObject({ requestId: "req-2", response: { behavior: "deny" } });
  });

  it("a Bash request shows the command and description with no diff", () => {
    addRequest({
      tool_name: "Bash",
      input: { command: "git status --short", description: "Show working tree status" },
      decision_reason: "Command not in allow list",
    });
    const { container } = card();
    expect(screen.getByText("Allow this bash command?")).toBeInTheDocument();
    expect(screen.getByText("git status --short")).toBeInTheDocument();
    expect(screen.getByText("Show working tree status")).toBeInTheDocument();
    expect(screen.getByText("Command not in allow list")).toBeInTheDocument();
    expect(container.querySelector(".perm-diff")).toBeNull();
  });

  it("an unknown tool shows its display name, title, and blocked path", () => {
    addRequest({
      tool_name: "mcp__x__do",
      display_name: "Do Thing",
      title: "Claude wants to do the thing",
      blocked_path: "/secret/dir",
      input: { a: 1 },
    });
    card();
    expect(screen.getByText(/Do you want to proceed with/)).toHaveTextContent("Do you want to proceed with Do Thing?");
    expect(screen.getByText("Claude wants to do the thing")).toBeInTheDocument();
    expect(screen.getByText("/secret/dir")).toBeInTheDocument();
  });
});

describe("plan approval", () => {
  it("renders the plan markdown with approve / keep-planning choices; keep planning with feedback denies with it", async () => {
    addRequest({ tool_name: "ExitPlanMode", input: { plan: "# The Plan\n\n- step **one**\n- step two" } });
    const { container } = card();
    expect(screen.getByRole("heading", { name: "The Plan" })).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("one");
    expect(screen.getByRole("button", { name: /^1\s*Yes, and auto-accept$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^2\s*Yes, and manually approve edits$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^3\s*No, keep planning$/ })).toBeInTheDocument();

    const feedback = screen.getByPlaceholderText("Tell Claude what to do instead");
    fireEvent.change(feedback, { target: { value: "split step two" } });
    fireEvent.keyDown(feedback, { key: "Enter" });
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({
      behavior: "deny",
      message: `${REJECT_WITH_REASON_PREFIX} split step two`,
      interrupt: false,
    });
  });

  it("keep planning without feedback sends the stay-in-plan-mode message", async () => {
    addRequest({ tool_name: "ExitPlanMode", input: { plan: "p" } });
    card();
    fireEvent.click(screen.getByRole("button", { name: /^3\s*No, keep planning$/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({ behavior: "deny", message: KEEP_PLANNING_MESSAGE, interrupt: true });
  });

  it("approve + auto-accept sends allow with a session acceptEdits mode; manual sends default mode", async () => {
    const input = { plan: "p" };
    addRequest({ tool_name: "ExitPlanMode", input });
    card();
    fireEvent.click(screen.getByRole("button", { name: /^1\s*Yes, and auto-accept$/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });

    cleanup();
    addRequest({ tool_name: "ExitPlanMode", input }, null, "req-2");
    card(threadId, "req-2");
    fireEvent.click(screen.getByRole("button", { name: /^2\s*Yes, and manually approve edits$/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(2));
    expect(respondCalls()[1].response.updatedPermissions).toEqual([{ type: "setMode", mode: "default", destination: "session" }]);
  });
});

describe("AskUserQuestion", () => {
  const question = {
    question: "Which features do you want?",
    header: "Features",
    multiSelect: true,
    options: [
      { label: "Auth", description: "Login and sessions" },
      { label: "Search", description: "Full-text search" },
      { label: "Export", description: "CSV export" },
    ],
  };

  it("multi-select with three options returns the chosen options", async () => {
    const input = { questions: [question] };
    addRequest({ tool_name: "AskUserQuestion", input });
    card();
    expect(screen.getByText("Which features do you want?")).toBeInTheDocument();
    expect(screen.getByText("Full-text search")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: /Submit answers/ });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Auth/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Export/ }));
    expect(screen.getByRole("checkbox", { name: /Export/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(submit);
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which features do you want?": "Auth, Export" } },
    });
  });

  it("typing in Other returns the free text", async () => {
    const single = { ...question, question: "Which one?", header: "Pick", multiSelect: false };
    const input = { questions: [single] };
    addRequest({ tool_name: "AskUserQuestion", input });
    card();
    fireEvent.change(screen.getByPlaceholderText(/Type something/), { target: { value: "GraphQL API" } });
    expect(screen.getByRole("radio", { name: /Other/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response.updatedInput.answers).toEqual({ "Which one?": "GraphQL API" });
  });

  it("multiple questions show tabs and require every answer", async () => {
    const q2 = { question: "Which DB?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] };
    addRequest({ tool_name: "AskUserQuestion", input: { questions: [question, q2] } });
    card();
    const tabs = screen.getByRole("tablist");
    expect(within(tabs).getByRole("tab", { name: "Features" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Search/ }));
    expect(screen.getByRole("button", { name: /Submit answers/ })).toBeDisabled();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Database" }));
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0].response.updatedInput.answers).toEqual({ "Which features do you want?": "Search", "Which DB?": "SQLite" });
  });
});

describe("background threads", () => {
  it("a request for a non-selected thread renders when its card mounts and answers that thread", async () => {
    const other = useAppStore.getState().createThread(useAppStore.getState().projects[0].id);
    useAppStore.setState({ selectedThreadId: threadId });
    expect(other).not.toBe(threadId);
    addRequest({ tool_name: "Bash", input: { command: "make" } }, null, "bg-1", other);
    expect(useThreadStore.getState().threads[other].pendingPermissions).toHaveLength(1);

    card(other, "bg-1");
    expect(screen.getByText("make")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^1\s*Yes$/ }));
    await waitFor(() => expect(respondCalls()).toHaveLength(1));
    expect(respondCalls()[0]).toMatchObject({ threadId: other, requestId: "bg-1" });
    await waitFor(() => expect(useThreadStore.getState().threads[other].pendingPermissions).toHaveLength(0));
  });
});

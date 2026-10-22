import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("../app/testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../app/testing/tauriMock")).dialogMock);

import { App } from "../app/App";
import { backend, callsTo, dialog, emitMenu, lastSaved, project, stateWith } from "../app/testing/tauriMock";
import { resetBackend } from "../app/testing/reset";
import type { PinnedCommand } from "../ipc/types";

const cmd = (c: Partial<PinnedCommand>): PinnedCommand => ({
  id: c.name ?? "x",
  name: "x",
  kind: "prompt",
  command: "do it",
  autoSubmit: true,
  placement: "after",
  hosts: [],
  enabled: true,
  ...c,
});

const rect = (top: number, height = 28) => ({ top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
const row = (name: string) => within(screen.getByRole("table", { name: "Pinned commands" })).getByText(name).closest("tr")!;

async function renderApp() {
  render(<App />);
  await screen.findByRole("navigation", { name: "Projects" });
  await waitFor(() => expect(backend.listeners.menu?.length).toBeTruthy());
}

async function openPinnedTab() {
  act(() => emitMenu("open_settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("tab", { name: "Pinned Commands" }));
  return settings;
}

/** Opens the composer's Commands menu. */
function openMenu() {
  const pill = screen.getByRole("button", { name: "Pinned commands" });
  if (pill.getAttribute("aria-expanded") !== "true") fireEvent.click(pill);
  return screen.getByRole("menu", { name: "Pinned commands" });
}
/** The command names the menu lists, without the Settings item. */
const menuNames = () =>
  within(openMenu())
    .getAllByRole("menuitem")
    .map((i) => i.querySelector(".composer-menu-label")!.textContent)
    .filter((n) => n !== "Add or edit commands…");
const runFromMenu = (name: string) =>
  fireEvent.click(within(openMenu()).getAllByRole("menuitem").find((i) => i.querySelector(".composer-menu-label")!.textContent === name)!);

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("pinned commands in Settings", () => {
  it("adds a command in its own dialog over Settings, and lists it in the table", async () => {
    await renderApp();
    const settings = await openPinnedTab();
    expect(within(settings).getByText("No pinned commands yet.")).toBeInTheDocument();

    fireEvent.click(within(settings).getByRole("button", { name: "Add Command" }));
    const editor = screen.getByRole("dialog", { name: "Add Command" });
    expect(within(editor).getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "Build" } });
    fireEvent.click(within(editor).getByRole("radio", { name: "Terminal Command" }));
    // A terminal command has no send option.
    expect(within(editor).queryByRole("checkbox", { name: /Send immediately/ })).toBeNull();
    fireEvent.change(within(editor).getByLabelText("Command"), { target: { value: " npm run build\n" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add" }));

    expect(screen.queryByRole("dialog", { name: "Add Command" })).toBeNull();
    const row = within(screen.getByRole("table", { name: "Pinned commands" })).getByText("Build").closest("tr")!;
    expect(row).toHaveTextContent("Terminal");
    expect(row).toHaveTextContent("npm run build");
    expect(row).toHaveTextContent("All hosts");
    expect(lastSaved()!.pinnedCommands).toEqual([
      // Kept as typed: a leading space keeps it out of the shell's history.
      { id: expect.any(String), name: "Build", kind: "terminal", command: " npm run build\n", autoSubmit: false, placement: "after", hosts: [], enabled: true },
    ]);
  });

  it("closes only the editor on Escape, and edits and deletes rows", async () => {
    resetBackend({ ...stateWith([]), pinnedCommands: [cmd({ name: "Review" }), cmd({ name: "Ship", kind: "terminal", command: "make ship", autoSubmit: false })] });
    await renderApp();
    await openPinnedTab();

    fireEvent.click(screen.getByRole("button", { name: "Edit Review" }));
    const editor = screen.getByRole("dialog", { name: "Edit Command" });
    fireEvent.keyDown(within(editor).getByLabelText("Name"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Edit Command" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Review" }));
    const again = screen.getByRole("dialog", { name: "Edit Command" });
    fireEvent.click(within(again).getByRole("checkbox", { name: /Send immediately/ }));
    fireEvent.click(within(again).getByRole("checkbox", { name: "All hosts" }));
    expect(within(again).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(within(again).getByRole("checkbox", { name: "This Mac" }));
    fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    expect(lastSaved()!.pinnedCommands![0]).toMatchObject({ name: "Review", autoSubmit: false, hosts: ["local"] });

    // Deleting asks first; Cancel keeps the command.
    dialog.ask.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete Ship" }));
    await waitFor(() => expect(dialog.ask).toHaveBeenCalledTimes(1));
    expect(dialog.ask).toHaveBeenCalledWith(expect.stringContaining('"Ship"'), expect.objectContaining({ title: "Delete command?", okLabel: "Delete" }));
    expect(lastSaved()!.pinnedCommands!.map((c) => c.name)).toEqual(["Review", "Ship"]);
    fireEvent.click(screen.getByRole("button", { name: "Delete Ship" }));
    await waitFor(() => expect(lastSaved()!.pinnedCommands!.map((c) => c.name)).toEqual(["Review"]));

    // The Edit dialog deletes too, and stays open when cancelled; adding has nothing to delete.
    fireEvent.click(screen.getByRole("button", { name: "Edit Review" }));
    dialog.ask.mockResolvedValueOnce(false);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit Command" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(dialog.ask).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("dialog", { name: "Edit Command" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit Command" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Command" })).toBeNull());
    expect(lastSaved()!.pinnedCommands).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Add Command" }));
    expect(within(screen.getByRole("dialog", { name: "Add Command" })).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("drag-reorders rows, which reorders the Commands menu", async () => {
    resetBackend({ ...stateWith([project("app")]), pinnedCommands: [cmd({ name: "A" }), cmd({ name: "B" }), cmd({ name: "C" })] });
    await renderApp();
    await openPinnedTab();
    ["A", "B", "C"].forEach((n, i) => (row(n).getBoundingClientRect = () => rect(i * 28)));

    // C dropped above B's midpoint lands between A and B.
    fireEvent.pointerDown(within(row("C")).getByText("C"), { clientY: 70, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 35, pointerId: 1 });
    expect(row("C")).toHaveClass("dragging");
    expect(row("B")).toHaveClass("drop-before");
    fireEvent.pointerUp(window, { clientY: 35, pointerId: 1 });

    expect(lastSaved()!.pinnedCommands!.map((c) => c.name)).toEqual(["A", "C", "B"]);
    expect(row("B")).not.toHaveClass("drop-before");
    // The click right after a drag is swallowed; the menu is opened after it.
    await new Promise((r) => setTimeout(r, 0));
    expect(menuNames()).toEqual(["A", "C", "B"]);
  });

  it("switches a command off and on, hiding it from the Commands menu but keeping it in Settings", async () => {
    resetBackend({ ...stateWith([project("app")]), pinnedCommands: [cmd({ name: "Review" }), cmd({ name: "Build" })] });
    await renderApp();
    await openPinnedTab();

    const toggle = screen.getByRole("switch", { name: "Show Review in the Commands menu" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(lastSaved()!.pinnedCommands![0]).toMatchObject({ name: "Review", enabled: false });
    expect(row("Review")).toHaveAttribute("data-disabled");
    expect(menuNames()).toEqual(["Build"]);

    fireEvent.click(toggle);
    expect(lastSaved()!.pinnedCommands![0].enabled).toBe(true);
    expect(menuNames()).toEqual(["Review", "Build"]);
  });

  it("treats commands saved before the enabled and placement settings as enabled, inserting after", async () => {
    const { enabled: _e, placement: _p, ...old } = cmd({ name: "Old", command: " old", autoSubmit: false });
    resetBackend({ ...stateWith([project("app")]), pinnedCommands: [old as PinnedCommand] });
    await renderApp();
    expect(menuNames()).toEqual(["Old"]);
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "typed" } });
    runFromMenu("Old");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Message input").value).toBe("typed old");
  });

  it("chooses where a filled prompt goes: before, after, or in place of what's typed", async () => {
    await renderApp();
    act(() => emitMenu("open_settings"));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("tab", { name: "Pinned Commands" }));
    fireEvent.click(within(settings).getByRole("button", { name: "Add Command" }));
    const editor = screen.getByRole("dialog", { name: "Add Command" });
    // Only a prompt that fills the composer has a placement.
    expect(within(editor).queryByRole("radiogroup", { name: "Text already in the composer" })).toBeNull();
    fireEvent.click(within(editor).getByRole("checkbox", { name: /Send immediately/ }));
    const where = within(editor).getByRole("radiogroup", { name: "Text already in the composer" });
    expect(within(where).getAllByRole("radio").map((r) => r.parentElement!.textContent)).toEqual(["Insert before", "Insert after", "Replace"]);
    expect(within(where).getByRole("radio", { name: "Insert after" })).toBeChecked();
    fireEvent.click(within(where).getByRole("radio", { name: "Insert before" }));
    fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "Review" } });
    fireEvent.change(within(editor).getByLabelText("Prompt"), { target: { value: "/review " } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add" }));
    expect(lastSaved()!.pinnedCommands![0]).toMatchObject({ command: "/review ", autoSubmit: false, placement: "before" });
    expect(within(screen.getByRole("table", { name: "Pinned commands" })).getByText("Insert before")).toBeInTheDocument();
  });

  it("puts a filled prompt before what's typed, or replaces it", async () => {
    resetBackend({
      ...stateWith([project("app")]),
      pinnedCommands: [
        cmd({ name: "Review", command: "/review ", autoSubmit: false, placement: "before" }),
        cmd({ name: "Fresh", command: "start over", autoSubmit: false, placement: "replace" }),
      ],
    });
    await renderApp();
    const input = screen.getByLabelText<HTMLTextAreaElement>("Message input");
    fireEvent.change(input, { target: { value: "the auth module" } });
    runFromMenu("Review");
    expect(input.value).toBe("/review the auth module");
    expect(input.selectionStart).toBe(input.value.length);
    runFromMenu("Fresh");
    expect(input.value).toBe("start over");
  });
});

describe("the Commands menu", () => {
  it("sends a prompt at once, or fills the composer with it, as written", async () => {
    resetBackend({
      ...stateWith([project("app")]),
      pinnedCommands: [cmd({ name: "Review", command: " review the diff" }), cmd({ name: "Plan", command: " plan this:", autoSubmit: false })],
    });
    await renderApp();

    runFromMenu("Review");
    await waitFor(() => expect(callsTo("claude_send_user")).toHaveLength(1));
    expect(callsTo("claude_send_user")[0].args).toEqual({ threadId: "app-t1", content: [{ type: "text", text: " review the diff" }] });

    const input = screen.getByLabelText<HTMLTextAreaElement>("Message input");
    fireEvent.change(input, { target: { value: "context" } });
    runFromMenu("Plan");
    // After what's typed, joined as written: the prompt's own leading space separates them.
    expect(input.value).toBe("context plan this:");
    expect(input).toHaveFocus();
    expect(callsTo("claude_send_user")).toHaveLength(1);
  });

  it("runs a terminal command in a new tab, in the thread's worktree", async () => {
    resetBackend({
      ...stateWith([project("app", [{ terminalVisible: false, worktree: { path: "/Users/me/.speedy/wt/app-1", branch: "speedy/app-1" } }])]),
      pinnedCommands: [cmd({ name: "Build", kind: "terminal", command: " npm run build\n", autoSubmit: false })],
    });
    await renderApp();

    runFromMenu("Build");
    expect(document.querySelector(".terminal-region")).toBeVisible();
    await waitFor(() => expect(callsTo("pty_write").map((c) => c.args)).toEqual([{ terminalId: "app-t1:2", data: " npm run build\r" }]));
    expect(callsTo("host_pty_attach").find((c) => c.args?.terminalId === "app-t1:2")?.args?.cwd).toBe("/Users/me/.speedy/wt/app-1");
    expect(within(screen.getByRole("tablist", { name: "Terminals" })).getByRole("tab", { name: "Build" })).toHaveAttribute("aria-selected", "true");
  });

  it("closes after running a command, and opens Settings on Pinned Commands to add or edit", async () => {
    resetBackend({ ...stateWith([project("app")]), pinnedCommands: [cmd({ name: "Review", autoSubmit: false })] });
    await renderApp();
    runFromMenu("Review");
    expect(screen.queryByRole("menu", { name: "Pinned commands" })).toBeNull();

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Add or edit commands…" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("tab", { name: "Pinned Commands" })).toHaveAttribute("aria-selected", "true");
    expect(within(settings).getByRole("tab", { name: "Pinned Commands" })).toHaveFocus();
    expect(within(settings).getByRole("table", { name: "Pinned commands" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Pinned commands" })).toBeNull();
  });

  it("hides the Commands pill while the thread's host has no enabled commands", async () => {
    resetBackend({
      ...stateWith([project("app")]),
      pinnedCommands: [cmd({ name: "Off", enabled: false }), cmd({ name: "Elsewhere", hosts: ["mac-mini"] })],
    });
    await renderApp();
    expect(screen.queryByRole("button", { name: "Pinned commands" })).toBeNull();
  });

  it("shows only the commands pinned to the thread's host", async () => {
    resetBackend({
      ...stateWith([project("app")]),
      pinnedCommands: [cmd({ name: "Everywhere" }), cmd({ name: "Here", hosts: ["local"] }), cmd({ name: "Elsewhere", hosts: ["mac-mini"] })],
    });
    await renderApp();
    expect(menuNames()).toEqual(["Everywhere", "Here"]);
  });
});

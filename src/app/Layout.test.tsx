import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("./testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("./testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("./testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("./testing/tauriMock")).dialogMock);

import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { App } from "./App";
import { backend, callsTo, dialog, emitMenu, lastSaved, openFolders, project, stateWith } from "./testing/tauriMock";
import { resetBackend, runtime } from "./testing/reset";

const chatRegion = () => document.querySelector<HTMLElement>(".chat-region");
const terminalRegion = () => document.querySelector<HTMLElement>(".terminal-region");
const threadRow = (title: string) =>
  within(screen.getByRole("navigation", { name: "Projects" })).getByText(title).closest<HTMLElement>("[role=treeitem]")!;

async function renderApp() {
  const utils = render(<App />);
  await screen.findByRole("navigation", { name: "Projects" });
  // The menu listener registers asynchronously; an event emitted before it exists is lost.
  await waitFor(() => expect(backend.listeners.menu?.length).toBeTruthy());
  return utils;
}

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("Layout", () => {
  it("adds a folder through the picker as a project with one new, selected thread", async () => {
    dialog.open.mockResolvedValue("/Users/me/speedy");
    await renderApp();
    const main = screen.getByRole("main");
    fireEvent.click(within(main).getByRole("button", { name: "Add Project Folder" }));

    const sidebar = screen.getByRole("navigation", { name: "Projects" });
    await within(sidebar).findByText("speedy");
    expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    const rows = within(sidebar).getAllByRole("treeitem").filter((r) => r.classList.contains("thread-row"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("aria-selected", "true");

    const saved = lastSaved()!;
    expect(saved.projects).toHaveLength(1);
    expect(saved.projects[0].path).toBe("/Users/me/speedy");
    expect(saved.selectedThreadId).toBe(saved.projects[0].threads[0].id);
    expect(chatRegion()).toHaveAttribute("data-thread-id", saved.projects[0].threads[0].id);
  });

  it("shows only the selected thread's chat and terminal and leaves other threads' runtime alone", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t1"));
    const a = runtime("working");
    useThreadStore.setState({ threads: { "app-t1": a, "app-t2": runtime("idle") } });
    await renderApp();
    expect(chatRegion()).toHaveAttribute("data-thread-id", "app-t1");
    expect(terminalRegion()).toHaveAttribute("data-thread-id", "app-t1");

    fireEvent.click(threadRow("app thread 2"));
    expect(chatRegion()).toHaveAttribute("data-thread-id", "app-t2");
    expect(terminalRegion()).toHaveAttribute("data-thread-id", "app-t2");
    expect(document.querySelectorAll(".chat-region")).toHaveLength(1);
    expect(document.querySelectorAll(".terminal-region")).toHaveLength(1);
    expect(useThreadStore.getState().threads["app-t1"]).toBe(a);
    expect(lastSaved()!.selectedThreadId).toBe("app-t2");
  });

  it("toggles the terminal per thread, and each thread keeps its split ratio", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t1"));
    await renderApp();
    const split = document.querySelector<HTMLElement>(".thread-split")!;
    split.getBoundingClientRect = () => ({ top: 0, height: 1000, bottom: 1000, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON() {} });

    // Drag the sash of thread 1 to 40%.
    const sash = screen.getByRole("separator", { name: "Resize terminal" });
    fireEvent.pointerDown(sash, { clientY: 650, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 400, pointerId: 1 });
    expect(chatRegion()!.style.flexBasis).toBe("40%");
    expect(useAppStore.getState().projects[0].threads[0].splitRatio).toBeCloseTo(0.4);

    // Hide thread 1's terminal.
    act(() => emitMenu("toggle_terminal"));
    expect(terminalRegion()).not.toBeVisible();
    expect(screen.queryByRole("separator", { name: "Resize terminal" })).toBeNull();

    // Thread 2 still shows its own terminal with the default ratio.
    fireEvent.click(threadRow("app thread 2"));
    expect(terminalRegion()).toBeVisible();
    expect(chatRegion()!.style.flexBasis).toBe("65%");

    // Back on thread 1: still hidden; showing it again restores 40%.
    fireEvent.click(threadRow("app thread 1"));
    expect(terminalRegion()).not.toBeVisible();
    act(() => emitMenu("toggle_terminal"));
    expect(terminalRegion()).toBeVisible();
    expect(chatRegion()!.style.flexBasis).toBe("40%");
    expect(lastSaved()!.projects[0].threads[0]).toMatchObject({ splitRatio: 0.4, terminalVisible: true });
  });

  it("maximizes the terminal over the chat and restores it", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    act(() => emitMenu("maximize_terminal"));
    expect(chatRegion()).not.toBeVisible();
    expect(terminalRegion()).toBeVisible();
    expect(lastSaved()!.projects[0].threads[0].terminalMaximized).toBe(true);
    act(() => emitMenu("maximize_terminal"));
    expect(chatRegion()).toBeVisible();
  });

  it("adds terminal tabs, switches between them, and hides the panel when the last is killed", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    expect(screen.queryByRole("tablist", { name: "Terminals" })).toBeNull();

    // New Terminal shows the hidden panel with a second shell, and lists both.
    act(() => emitMenu("toggle_terminal"));
    expect(terminalRegion()).not.toBeVisible();
    act(() => emitMenu("new_terminal"));
    expect(terminalRegion()).toBeVisible();
    const tabs = screen.getByRole("tablist", { name: "Terminals" });
    const tab = (name: string) => within(tabs).getByRole("tab", { name });
    expect(tab("Terminal 2")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(callsTo("pty_open").map((c) => c.args?.terminalId)).toContain("app-t1:2"));
    const panes = () => [...document.querySelectorAll<HTMLElement>(".terminal-pane")].map((p) => !p.hidden);
    expect(panes()).toEqual([false, true]);

    fireEvent.click(tab("Terminal 1"));
    expect(panes()).toEqual([true, false]);

    // Killing a tab closes its shell and activates its neighbour; the list goes with one left.
    fireEvent.click(within(tabs).getByRole("button", { name: "Kill Terminal 1" }));
    expect(callsTo("pty_close").map((c) => c.args)).toEqual([{ terminalId: "app-t1" }]);
    expect(screen.queryByRole("tablist", { name: "Terminals" })).toBeNull();
    expect(panes()).toEqual([true]);

    fireEvent.click(screen.getByRole("button", { name: "Kill Terminal" }));
    expect(callsTo("pty_close").map((c) => c.args?.terminalId)).toEqual(["app-t1", "app-t1:2"]);
    expect(terminalRegion()).not.toBeVisible();
    // Reopening starts a fresh shell.
    act(() => emitMenu("toggle_terminal"));
    expect(panes()).toEqual([true]);
    await waitFor(() => expect(callsTo("pty_open").map((c) => c.args?.terminalId)).toContain("app-t1:3"));
  });

  it("shows an empty state with Add Project Folder when no thread is selected", async () => {
    await renderApp();
    expect(within(screen.getByRole("main")).getByRole("button", { name: "Add Project Folder" })).toBeInTheDocument();
    expect(chatRegion()).toBeNull();
  });
});

describe("Close thread (Cmd+W)", () => {
  it("asks before closing a Working thread and keeps it when cancelled", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t1"));
    useThreadStore.setState({ threads: { "app-t1": runtime("working") } });
    dialog.ask.mockResolvedValue(false);
    await renderApp();

    act(() => emitMenu("close_thread"));
    await waitFor(() => expect(dialog.ask).toHaveBeenCalledTimes(1));
    expect(callsTo("claude_stop")).toHaveLength(0);
    expect(threadRow("app thread 1")).toBeInTheDocument();

    dialog.ask.mockResolvedValue(true);
    act(() => emitMenu("close_thread"));
    await waitFor(() => expect(screen.queryByText("app thread 1")).toBeNull());
    expect(callsTo("claude_stop").map((c) => c.args)).toEqual([{ threadId: "app-t1" }]);
  });

  it("asks when the thread's shell has a foreground process", async () => {
    resetBackend(stateWith([project("app")]));
    backend.foreground["app-t1"] = true;
    await renderApp();
    act(() => emitMenu("close_thread"));
    await waitFor(() => expect(dialog.ask).toHaveBeenCalledTimes(1));
  });

  it("asks when any of the thread's terminals has a foreground process, and closes them all", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t1"));
    backend.foreground["app-t1:2"] = true;
    dialog.ask.mockResolvedValue(true);
    await renderApp();
    act(() => emitMenu("new_terminal"));
    act(() => emitMenu("close_thread"));
    await waitFor(() => expect(dialog.ask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("app thread 1")).toBeNull());
    expect(callsTo("pty_close").map((c) => c.args?.terminalId)).toEqual(["app-t1", "app-t1:2"]);
  });

  it("archives an idle thread immediately, stops it, and restores it from Archived", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t1"));
    useThreadStore.setState({ threads: { "app-t1": runtime("idle") } });
    await renderApp();

    act(() => emitMenu("close_thread"));
    await waitFor(() => expect(screen.queryByText("app thread 1")).toBeNull());
    expect(dialog.ask).not.toHaveBeenCalled();
    expect(callsTo("claude_stop").map((c) => c.args)).toEqual([{ threadId: "app-t1" }]);
    expect(lastSaved()!.projects[0].threads[0].archived).toBe(true);
    expect(chatRegion()).toHaveAttribute("data-thread-id", "app-t2");

    fireEvent.contextMenu(screen.getByText("app").closest(".project-header")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show Archived (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore app thread 1" }));
    expect(threadRow("app thread 1")).toHaveAttribute("aria-selected", "true");
    expect(lastSaved()!.projects[0].threads[0].archived).toBe(false);
  });
});

describe("Menu shortcuts", () => {
  it("Cmd+N creates a thread in the selected thread's project", async () => {
    resetBackend(stateWith([project("app"), project("web")], "web-t1"));
    await renderApp();
    act(() => emitMenu("new_thread"));
    const web = useAppStore.getState().projects[1];
    expect(web.threads).toHaveLength(2);
    expect(useAppStore.getState().selectedThreadId).toBe(web.threads[1].id);
  });

  it("Cmd+2 selects the second visible thread", async () => {
    resetBackend(stateWith([project("app"), project("web")], "app-t1"));
    await renderApp();
    act(() => emitMenu("switch_thread_2"));
    expect(chatRegion()).toHaveAttribute("data-thread-id", "web-t1");
  });

  it("Cmd+L asks the composer to take focus", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    const seen: unknown[] = [];
    const onFocus = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("speedy:focus-composer", onFocus);
    act(() => emitMenu("focus_chat"));
    window.removeEventListener("speedy:focus-composer", onFocus);
    expect(seen).toEqual([{ threadId: "app-t1" }]);
  });

  it("hands focus back to the composer when the terminal panel closes", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    const seen: unknown[] = [];
    const onFocus = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("speedy:focus-composer", onFocus);
    act(() => emitMenu("toggle_terminal"));
    expect(seen).toEqual([{ threadId: "app-t1" }]);
    // Showing the panel focuses the terminal, not the composer.
    act(() => emitMenu("toggle_terminal"));
    expect(seen).toHaveLength(1);
    // Killing a tab with another left keeps focus in the terminal; killing the last one returns it.
    act(() => emitMenu("new_terminal"));
    fireEvent.click(screen.getByRole("button", { name: "Kill Terminal 2" }));
    expect(seen).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Kill Terminal" }));
    window.removeEventListener("speedy:focus-composer", onFocus);
    expect(seen).toEqual([{ threadId: "app-t1" }, { threadId: "app-t1" }]);
  });

  it("Cmd+O adds a project through the picker", async () => {
    dialog.open.mockResolvedValue("/Users/me/tools");
    await renderApp();
    act(() => emitMenu("add_project"));
    await screen.findByText("tools");
  });
});

describe("speedy <folder>", () => {
  it("adds folders opened before the window was ready", async () => {
    backend.pendingOpens.push("/Users/me/early");
    await renderApp();
    const sidebar = screen.getByRole("navigation", { name: "Projects" });
    await within(sidebar).findByText("early");
    expect(lastSaved()!.projects.map((p) => p.path)).toEqual(["/Users/me/early"]);
  });

  it("adds a new folder and selects a live thread for one already open", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t2"));
    await renderApp();
    await waitFor(() => expect(backend.listeners["open-folders"]?.length).toBeTruthy());

    act(() => openFolders("/Users/me/new"));
    const sidebar = screen.getByRole("navigation", { name: "Projects" });
    await within(sidebar).findByText("new");
    expect(lastSaved()!.projects.map((p) => p.path)).toEqual(["/Users/me/app", "/Users/me/new"]);

    act(() => openFolders("/Users/me/app"));
    await waitFor(() => expect(lastSaved()!.selectedThreadId).toBe("app-t1"));
    expect(lastSaved()!.projects).toHaveLength(2);
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("../app/testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../app/testing/tauriMock")).dialogMock);

import { App } from "../app/App";
import { backend, callsTo, lastSaved, project, stateWith } from "../app/testing/tauriMock";
import { resetBackend, runtime } from "../app/testing/reset";
import type { ThreadStatus } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { Sidebar } from "./Sidebar";

const sidebar = () => screen.getByRole("navigation", { name: "Projects" });
const threadRow = (title: string) => within(sidebar()).getByText(title).closest<HTMLElement>("[role=treeitem]")!;
const projectHeader = (name: string) => within(sidebar()).getByText(name).closest<HTMLElement>(".project-header")!;
const projectNames = () => [...sidebar().querySelectorAll(".project-header .project-name")].map((e) => e.textContent);

function rect(top: number, height = 22): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 260, width: 260, x: 0, y: top, toJSON() {} };
}

async function renderApp() {
  render(<App />);
  await screen.findByRole("navigation", { name: "Projects" });
}

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("Sidebar", () => {
  it("renders a distinct glyph and accessible label for every thread status", async () => {
    const statuses: [ThreadStatus, string, string][] = [
      ["not_started", "Not started", "codicon-circle-small"],
      ["starting", "Starting", "codicon-ellipsis"],
      ["idle", "Idle", "codicon-circle-small-filled"],
      ["working", "Working", "codicon-loading"],
      ["awaiting_user", "Waiting for your input", "codicon-bell-dot"],
      ["crashed", "Crashed", "codicon-debug-disconnect"],
      ["errored", "Error", "codicon-error"],
      ["stopped", "Stopped", "codicon-debug-stop"],
    ];
    resetBackend(stateWith([project("app", statuses.map(() => ({})))], null));
    useThreadStore.setState({
      threads: Object.fromEntries(statuses.map(([status], i) => [`app-t${i + 1}`, runtime(status)])),
    });
    await renderApp();

    statuses.forEach(([, label, glyph], i) => {
      const icon = within(threadRow(`app thread ${i + 1}`)).getByRole("img");
      expect(icon).toHaveAccessibleName(label);
      expect(icon).toHaveClass("codicon", glyph);
    });
    expect(within(threadRow("app thread 4")).getByRole("img")).toHaveClass("codicon-modifier-spin");
  });

  it("treats a thread with no runtime yet as not started, and shows the unread glyph", () => {
    useAppStore.setState({ ...stateWith([project("app", [{}, {}])], null), loaded: true });
    useThreadStore.setState({ threads: { "app-t2": runtime("idle") } });
    render(<Sidebar unread={new Set(["app-t2"])} />);
    expect(within(threadRow("app thread 1")).getByRole("img")).toHaveAccessibleName("Not started");
    const unread = within(threadRow("app thread 2")).getByRole("img");
    expect(unread).toHaveAccessibleName("Finished, unread");
    expect(unread).toHaveClass("codicon-circle-filled", "unread");
  });

  it("drag-reorders projects with pointer events and persists the order", async () => {
    resetBackend(stateWith([project("alpha"), project("beta")]));
    await renderApp();
    const alpha = projectHeader("alpha").closest<HTMLElement>(".project")!;
    const beta = projectHeader("beta").closest<HTMLElement>(".project")!;
    alpha.getBoundingClientRect = () => rect(0, 66);
    beta.getBoundingClientRect = () => rect(66, 66);

    fireEvent.pointerDown(projectHeader("alpha"), { clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 120, pointerId: 1 });

    expect(projectNames()).toEqual(["beta", "alpha"]);
    expect(lastSaved()!.projects.map((p) => p.name)).toEqual(["beta", "alpha"]);
    // The drag doesn't also count as a click that collapses the project.
    fireEvent.click(projectHeader("alpha"));
    expect(useAppStore.getState().projects[1].collapsed).toBe(false);
  });

  it("drag-reorders threads within a project", async () => {
    resetBackend(stateWith([project("app", [{}, {}])]));
    await renderApp();
    threadRow("app thread 1").getBoundingClientRect = () => rect(22);
    threadRow("app thread 2").getBoundingClientRect = () => rect(44);
    fireEvent.pointerDown(threadRow("app thread 1"), { clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 60, pointerId: 1 });
    expect(lastSaved()!.projects[0].threads.map((t) => t.id)).toEqual(["app-t2", "app-t1"]);
  });

  it("removes a project from the sidebar, stops its threads, and leaves its sessions alone", async () => {
    resetBackend(stateWith([project("alpha", [{}, {}]), project("beta")]));
    await renderApp();
    fireEvent.contextMenu(projectHeader("alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove Project" }));

    await waitFor(() => expect(projectNames()).toEqual(["beta"]));
    expect(lastSaved()!.projects.map((p) => p.name)).toEqual(["beta"]);
    expect(callsTo("claude_stop").map((c) => c.args)).toEqual([{ threadId: "alpha-t1" }, { threadId: "alpha-t2" }]);
    const sessionCalls = backend.calls.filter((c) => /session|delete|remove/i.test(c.cmd));
    expect(sessionCalls).toEqual([]);
  });

  it("renames a thread inline", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    fireEvent.doubleClick(within(threadRow("app thread 1")).getByText("app thread 1"));
    const input = within(sidebar()).getByRole("textbox", { name: "Thread name" });
    fireEvent.change(input, { target: { value: "Fix the login bug" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(sidebar()).getByText("Fix the login bug")).toBeInTheDocument();
    expect(lastSaved()!.projects[0].threads[0].title).toBe("Fix the login bug");
  });

  it("renames from the context menu, and Escape cancels", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    fireEvent.contextMenu(threadRow("app thread 1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = within(sidebar()).getByRole("textbox", { name: "Thread name" });
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(sidebar()).getByText("app thread 1")).toBeInTheDocument();
  });

  it("archives a thread from the context menu", async () => {
    resetBackend(stateWith([project("app", [{}, {}])]));
    await renderApp();
    fireEvent.contextMenu(threadRow("app thread 2"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(within(sidebar()).queryByText("app thread 2")).toBeNull());
    expect(within(sidebar()).getByRole("button", { name: /Archived \(1\)/ })).toBeInTheDocument();
  });

  it("creates a thread from the project's + button and the context menu", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    fireEvent.click(within(projectHeader("app")).getByRole("button", { name: "New Thread" }));
    fireEvent.contextMenu(projectHeader("app"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New Thread" }));
    const threads = useAppStore.getState().projects[0].threads;
    expect(threads).toHaveLength(3);
    expect(within(sidebar()).getAllByText("New thread")).toHaveLength(2);
    expect(useAppStore.getState().selectedThreadId).toBe(threads[2].id);
  });

  it("opens past conversations in a popover from the history button and the context menu", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    fireEvent.click(within(projectHeader("app")).getByRole("button", { name: "Show Past Conversations" }));
    const popover = screen.getByRole("dialog", { name: "Past conversations in app" });
    expect(within(popover).getByPlaceholderText("Search sessions…")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.contextMenu(projectHeader("app"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show Past Conversations" }));
    expect(screen.getByRole("dialog", { name: "Past conversations in app" })).toBeInTheDocument();
  });

  it("collapses a project", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    await within(sidebar()).findByText("app thread 1");
    fireEvent.click(projectHeader("app"));
    await waitFor(() => expect(within(sidebar()).queryByText("app thread 1")).toBeNull());
    expect(projectHeader("app")).toHaveAttribute("aria-expanded", "false");
    expect(lastSaved()!.projects[0].collapsed).toBe(true);
  });

  it("marks a project whose folder is missing", async () => {
    resetBackend(stateWith([project("gone"), project("here")]));
    backend.dirs.delete("/Users/me/gone");
    await renderApp();
    await within(projectHeader("gone")).findByText("missing");
    expect(projectHeader("gone")).toHaveAttribute("title", expect.stringContaining("/Users/me/gone"));
    expect(within(projectHeader("here")).queryByText("missing")).toBeNull();
  });

  it("turns folders dropped on the window into projects and ignores files", async () => {
    await renderApp();
    backend.dirs.add("/Users/me/dropped");
    backend.files.add("/Users/me/notes.txt");
    await waitFor(() => expect(backend.dragDrop).not.toBeNull());
    await act(async () => {
      backend.dragDrop!({ payload: { type: "drop", paths: ["/Users/me/notes.txt", "/Users/me/dropped"], position: { x: 0, y: 0 } } });
    });
    await within(sidebar()).findByText("dropped");
    expect(useAppStore.getState().projects.map((p) => p.path)).toEqual(["/Users/me/dropped"]);
  });
});

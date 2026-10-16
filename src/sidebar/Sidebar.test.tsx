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
import { useAppStore, visibleThreads } from "../store/appStore";
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

  it("opens a project's folder in VS Code from its context menu", async () => {
    resetBackend(stateWith([project("alpha")]));
    await renderApp();
    fireEvent.contextMenu(projectHeader("alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in VS Code" }));

    await waitFor(() => expect(callsTo("open_in_vscode").map((c) => c.args)).toEqual([{ path: useAppStore.getState().projects[0].path }]));
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
    // Archived threads stay out of the tree until asked for.
    expect(within(sidebar()).queryByRole("button", { name: /Archived/ })).toBeNull();
    fireEvent.contextMenu(projectHeader("app"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show Archived (1)" }));
    expect(within(sidebar()).getByText("app thread 2")).toBeInTheDocument();
    fireEvent.click(within(sidebar()).getByRole("button", { name: /Archived \(1\)/ }));
    expect(within(sidebar()).queryByText("app thread 2")).toBeNull();
  });

  it("shows a placeholder under a project with no live threads, which starts a new one", async () => {
    resetBackend(stateWith([project("app", [{ archived: true }])], null));
    await renderApp();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "No threads" }));
    await waitFor(() => expect(within(sidebar()).queryByRole("button", { name: "No threads" })).toBeNull());
    expect(lastSaved()!.projects[0].threads.filter((t) => !t.archived)).toHaveLength(1);
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
  describe("groups", () => {
    const groupHeader = (name: string) => within(sidebar()).getByText(name).closest<HTMLElement>(".group-header")!;
    const groupMembers = (name: string) =>
      [...groupHeader(name).closest(".group")!.querySelectorAll(".project-name")].map((e) => e.textContent);

    it("moves a project into a new group named inline, and persists it", async () => {
      resetBackend(stateWith([project("alpha"), project("beta")]));
      await renderApp();
      fireEvent.contextMenu(projectHeader("beta"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to New Group…" }));
      const input = screen.getByRole("textbox", { name: "Group name" });
      fireEvent.change(input, { target: { value: "Work" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(groupMembers("Work")).toEqual(["beta"]);
      expect(projectNames()).toEqual(["alpha", "beta"]);
      const saved = lastSaved()!;
      expect(saved.groups.map((g) => g.name)).toEqual(["Work"]);
      expect(saved.projects.find((p) => p.name === "beta")!.groupId).toBe(saved.groups[0].id);
    });

    it("moves projects between groups and back out from the context menu", async () => {
      resetBackend({
        ...stateWith([project("alpha", [{}], { groupId: "g1" }), project("beta")]),
        groups: [
          { id: "g1", name: "Work", collapsed: false, color: "blue" },
          { id: "g2", name: "Personal", collapsed: false, color: "green" },
        ],
      });
      await renderApp();
      expect(groupMembers("Work")).toEqual(["alpha"]);
      fireEvent.contextMenu(projectHeader("alpha"));
      expect(screen.queryByRole("menuitem", { name: "Move to Work" })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to Personal" }));
      expect(groupMembers("Personal")).toEqual(["alpha"]);

      fireEvent.contextMenu(projectHeader("alpha"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Group" }));
      expect(groupMembers("Personal")).toEqual([]);
      expect(lastSaved()!.projects.find((p) => p.name === "alpha")!.groupId).toBeNull();
    });

    it("collapses a group, hiding its threads from Cmd+number, and deleting it ungroups its projects", async () => {
      resetBackend({
        ...stateWith([project("alpha", [{}], { groupId: "g1" }), project("beta")]),
        groups: [{ id: "g1", name: "Work", collapsed: false, color: "blue" }],
      });
      await renderApp();
      // Ungrouped projects come first.
      expect(visibleThreads(useAppStore.getState()).map((t) => t.id)).toEqual(["beta-t1", "alpha-t1"]);
      fireEvent.click(groupHeader("Work"));
      await waitFor(() => expect(within(sidebar()).queryByText("alpha")).toBeNull());
      expect(visibleThreads(useAppStore.getState()).map((t) => t.id)).toEqual(["beta-t1"]);

      fireEvent.contextMenu(groupHeader("Work"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete Group" }));
      expect(within(sidebar()).queryByText("Work")).toBeNull();
      expect(projectNames()).toEqual(["alpha", "beta"]);
      expect(lastSaved()!.groups).toEqual([]);
    });

    it("gives each group a color: new groups take an unused one, uncolored saved groups get one, and the menu changes it", async () => {
      resetBackend({
        ...stateWith([project("alpha")]),
        groups: [
          { id: "g1", name: "Work", collapsed: false, color: "blue" },
          { id: "g2", name: "Old", collapsed: false, color: null },
        ],
      });
      await renderApp();
      expect(useAppStore.getState().groups.map((g) => g.color)).toEqual(["blue", "green"]);
      expect(groupHeader("Old").closest<HTMLElement>(".group")!.style.getPropertyValue("--group-color")).toBe("var(--vscode-charts-green)");

      fireEvent.click(within(sidebar()).getByRole("button", { name: "New Group" }));
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Group name" }), { key: "Enter" });
      expect(useAppStore.getState().groups[2].color).toBe("orange");

      fireEvent.contextMenu(groupHeader("Work"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Change Color…" }));
      const purple = await screen.findByRole("menuitemradio", { name: "Purple" });
      expect(screen.getByRole("menuitemradio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(purple);
      expect(lastSaved()!.groups[0].color).toBe("purple");
    });

    it("drag-reorders projects within a group without leaving it", async () => {
      resetBackend({
        ...stateWith([project("alpha", [{}], { groupId: "g1" }), project("solo"), project("beta", [{}], { groupId: "g1" })]),
        groups: [{ id: "g1", name: "Work", collapsed: false, color: "blue" }],
      });
      await renderApp();
      const alpha = projectHeader("alpha").closest<HTMLElement>(".project")!;
      const beta = projectHeader("beta").closest<HTMLElement>(".project")!;
      alpha.getBoundingClientRect = () => rect(100, 44);
      beta.getBoundingClientRect = () => rect(144, 44);

      fireEvent.pointerDown(projectHeader("alpha"), { clientY: 110, button: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { clientY: 200, pointerId: 1 });
      fireEvent.pointerUp(window, { clientY: 200, pointerId: 1 });

      expect(groupMembers("Work")).toEqual(["beta", "alpha"]);
      expect(lastSaved()!.projects.map((p) => [p.name, p.groupId ?? null])).toEqual([
        ["solo", null],
        ["beta", "g1"],
        ["alpha", "g1"],
      ]);
    });
  });
});

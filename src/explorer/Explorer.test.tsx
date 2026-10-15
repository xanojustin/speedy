import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("../app/testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../app/testing/tauriMock")).dialogMock);

import { App } from "../app/App";
import { backend, callsTo, dialog, emitMenu, project, stateWith } from "../app/testing/tauriMock";
import { resetBackend } from "../app/testing/reset";
import { makeThread } from "../store/appStore";

const explorer = () => screen.queryByLabelText("Explorer");

async function renderApp() {
  render(<App />);
  await screen.findByRole("navigation", { name: "Projects" });
  await waitFor(() => expect(backend.listeners.menu?.length).toBeTruthy());
}

beforeEach(() => {
  resetBackend(stateWith([project("app")]));
  backend.projectFiles = { "README.md": "# Hello\n", "docs/plan.md": "plan\n", "src/main.ts": "let x = 1;\n" };
  backend.gitChanges = [{ path: "docs/plan.md", status: "M" }];
});
afterEach(cleanup);

describe("Explorer", () => {
  it("is hidden by default, and new threads start with the terminal hidden", async () => {
    await renderApp();
    expect(explorer()).toBeNull();
    expect(makeThread().terminalVisible).toBe(false);
  });

  it("toggles from the menu and lists the project with git decorations", async () => {
    await renderApp();
    act(() => emitMenu("toggle_explorer"));
    const tree = await screen.findByRole("tree", { name: "Files in app" });
    await within(tree).findByText("README.md");
    const docs = within(tree).getByText("docs").closest("button")!;
    await waitFor(() => expect(docs).toHaveAttribute("data-git", "M"));

    fireEvent.click(docs);
    const plan = (await within(tree).findByText("plan.md")).closest("button")!;
    expect(plan).toHaveAttribute("data-git", "M");

    act(() => emitMenu("toggle_explorer"));
    expect(explorer()).toBeNull();
  });

  it("previews Markdown, edits and saves it, and shows changes vs HEAD", async () => {
    await renderApp();
    act(() => emitMenu("toggle_explorer"));
    const tree = await screen.findByRole("tree", { name: "Files in app" });
    fireEvent.click(await within(tree).findByText("docs"));
    fireEvent.click(await within(tree).findByText("plan.md"));

    const panel = explorer()!;
    expect(await within(panel).findByText("plan")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("tab", { name: "Edit" }));
    const editor = within(panel).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "new plan\n" } });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => expect(backend.projectFiles["docs/plan.md"]).toBe("new plan\n"));
    expect(within(panel).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(within(panel).getByRole("tab", { name: "Changes vs HEAD" }));
    await waitFor(() => expect(callsTo("explorer_git_diff")).toHaveLength(1));
    expect(await within(panel).findByText("+1")).toBeInTheDocument();
  });

  it("asks before discarding unsaved edits", async () => {
    await renderApp();
    act(() => emitMenu("toggle_explorer"));
    fireEvent.click(await within(await screen.findByRole("tree", { name: "Files in app" })).findByText("README.md"));
    const panel = explorer()!;
    fireEvent.click(await within(panel).findByRole("tab", { name: "Edit" }));
    fireEvent.change(await within(panel).findByRole("textbox"), { target: { value: "changed" } });

    dialog.ask.mockResolvedValueOnce(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Back to Files" }));
    await waitFor(() => expect(dialog.ask).toHaveBeenCalledTimes(1));
    expect(within(panel).getByRole("textbox")).toHaveValue("changed");

    fireEvent.click(within(panel).getByRole("button", { name: "Back to Files" }));
    expect(await screen.findByRole("tree", { name: "Files in app" })).toBeInTheDocument();
    expect(backend.projectFiles["README.md"]).toBe("# Hello\n");
  });
});

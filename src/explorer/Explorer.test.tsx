import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("../app/testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../app/testing/tauriMock")).dialogMock);

import { App } from "../app/App";
import { backend, callsTo, dialog, emitMenu, project, stateWith } from "../app/testing/tauriMock";
import { resetBackend } from "../app/testing/reset";
import type { ClientState } from "../ipc/types";
import { makeThread, useAppStore } from "../store/appStore";

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

  it("lists gitignored entries dimmed, including everything under an ignored folder", async () => {
    backend.projectFiles = { ...backend.projectFiles, ".env": "SECRET=1\n", "dist/out.js": "" };
    backend.ignoredPaths = [".env", "dist"];
    await renderApp();
    act(() => emitMenu("toggle_explorer"));
    const tree = await screen.findByRole("tree", { name: "Files in app" });
    const env = (await within(tree).findByText(".env")).closest("button")!;
    expect(env).toHaveAttribute("data-ignored");
    expect(env).toHaveAttribute("title", ".env • Ignored");
    expect(within(tree).getByText("README.md").closest("button")).not.toHaveAttribute("data-ignored");

    fireEvent.click(within(tree).getByText("dist"));
    expect((await within(tree).findByText("out.js")).closest("button")).toHaveAttribute("data-ignored");
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

  it("opens the folder it is showing in VS Code: the thread's worktree if it has one", async () => {
    resetBackend(
      stateWith([
        project("app", [{}, { worktree: { path: "/Users/me/.worktrees/app-feature", branch: "feature" } }]),
      ]),
    );
    await renderApp();
    act(() => emitMenu("toggle_explorer"));
    fireEvent.click(within(explorer()!).getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => expect(callsTo("open_in_vscode").map((c) => c.args)).toEqual([{ path: "/Users/me/app", host: "local" }]));

    fireEvent.click(screen.getByText("app thread 2"));
    act(() => emitMenu("toggle_explorer"));
    fireEvent.click(within(await waitFor(() => explorer()!)).getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() =>
      expect(callsTo("open_in_vscode").map((c) => c.args)).toEqual([
        { path: "/Users/me/app", host: "local" },
        { path: "/Users/me/.worktrees/app-feature", host: "local" },
      ]),
    );
  });
});

describe("Explorer per thread", () => {
  beforeEach(() => {
    resetBackend(stateWith([project("app", [{}, {}])]));
    backend.projectFiles = { "README.md": "# Hello\n" };
  });

  it("is shown or hidden per thread, and remembered in client.json", async () => {
    await renderApp();
    act(() => emitMenu("toggle_explorer"));
    expect(await screen.findByRole("tree", { name: "Files in app" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("app thread 2"));
    await waitFor(() => expect(explorer()).toBeNull());

    fireEvent.click(screen.getByText("app thread 1"));
    expect(await screen.findByRole("tree", { name: "Files in app" })).toBeInTheDocument();
    await waitFor(() =>
      expect((callsTo("client_state_save").at(-1)!.args!.state as ClientState).threads.map((t) => [t.threadId, t.explorerVisible])).toEqual([
        ["app-t1", true],
        ["app-t2", false],
      ]),
    );
  });

  it("keeps each thread's open file and unsaved edits across thread switches", async () => {
    await renderApp();
    act(() => emitMenu("toggle_explorer"));
    fireEvent.click(await within(await screen.findByRole("tree", { name: "Files in app" })).findByText("README.md"));
    fireEvent.click(await within(explorer()!).findByRole("tab", { name: "Edit" }));
    fireEvent.change(await within(explorer()!).findByRole("textbox"), { target: { value: "half done" } });

    fireEvent.click(screen.getByText("app thread 2"));
    act(() => emitMenu("toggle_explorer"));
    // The other thread has its own explorer, showing the tree.
    expect(await screen.findByRole("tree", { name: "Files in app" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("app thread 1"));
    expect(await within(await waitFor(() => explorer()!)).findByRole("textbox")).toHaveValue("half done");
    expect(within(explorer()!).getByLabelText("Unsaved")).toBeInTheDocument();
    expect(backend.projectFiles["README.md"]).toBe("# Hello\n");
  });
});

describe("Explorer reveal (transcript file links)", () => {
  const reveal = (path: string, line: number | null) => act(() => useAppStore.getState().revealInExplorer(path, line));

  it("opens the explorer on a path relative to the thread's folder", async () => {
    backend.files.add("/Users/me/app/src/main.ts");
    await renderApp();
    reveal("src/main.ts", 1);
    expect(await screen.findByTitle("src/main.ts")).toHaveTextContent("main.ts");
    expect(useAppStore.getState().explorerReveal).toBeNull();
  });

  it("finds a bare file name or an absolute path inside the folder", async () => {
    await renderApp();
    reveal("main.ts", 1);
    expect(await screen.findByTitle("src/main.ts")).toBeInTheDocument();

    backend.files.add("/Users/me/app/README.md");
    reveal("/Users/me/app/README.md", null);
    expect(await screen.findByTitle("README.md")).toBeInTheDocument();
  });

  it("marks the linked line", async () => {
    backend.projectFiles["src/main.ts"] = "one\ntwo\nthree\n";
    backend.files.add("/Users/me/app/src/main.ts");
    await renderApp();
    reveal("src/main.ts", 2);
    await screen.findByTitle("src/main.ts");
    await waitFor(() => expect(document.querySelector(".explorer-line-target")).toHaveTextContent("two"));
  });

  it("refuses paths outside the folder", async () => {
    await renderApp();
    reveal("/etc/passwd.txt", null);
    expect(await screen.findByText("/etc/passwd.txt is outside this thread's folder.")).toBeInTheDocument();
  });
});

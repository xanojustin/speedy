// U12: the host UI: a sidebar section per host, adding a project on a remote host, VS Code
// remote windows, the composer while a host is away, and the token fallback in Settings.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("../app/testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../app/testing/tauriMock")).dialogMock);

import { App } from "../app/App";
import { backend, callsTo, emitMenu, project, readySetup, stateWith } from "../app/testing/tauriMock";
import { resetBackend } from "../app/testing/reset";
import { useAppStore, visibleThreads } from "../store/appStore";

const MINI_UP = { state: "connected", host_id: "mini-1", agent_version: "0.1.0" };
const MINI_DOWN = { state: "reconnecting", error: "ssh: connect to host mac-mini: Operation timed out" };

const sidebar = () => screen.getByRole("navigation", { name: "Projects" });
const hostSection = (name: string) => within(sidebar()).getByRole("region", { name });

/** This Mac with "app", and the Mac mini with "api". */
function twoHosts(mini: Record<string, unknown>) {
  resetBackend(stateWith([project("app"), project("api", [{}], { hostKey: "mac-mini", path: "/Users/me/api" })]));
  backend.extraHosts = [{ key: "mac-mini", state: mini }];
}

async function renderApp() {
  render(<App />);
  await screen.findByRole("navigation", { name: "Projects" });
}

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("hosts in the sidebar", () => {
  it("shows a section per host with its state, and an away host leaves the others usable", async () => {
    twoHosts(MINI_DOWN);
    await renderApp();
    const mac = await waitFor(() => hostSection("This Mac"));
    const mini = hostSection("mac-mini");
    expect(within(mac).getByText("Connected")).toBeInTheDocument();
    expect(within(mini).getByText("Reconnecting")).toHaveAttribute("title", MINI_DOWN.error);
    expect(within(mini).getByRole("button", { name: "Reconnect to mac-mini" })).toBeInTheDocument();

    fireEvent.click(within(mac).getByText("app thread 1"));
    expect(useAppStore.getState().selectedThreadId).toBe("app-t1");
  });

  it("collapses a host's section, remembers it, and skips its threads for Cmd+1–9", async () => {
    twoHosts(MINI_UP);
    await renderApp();
    const toggle = await waitFor(() => within(hostSection("This Mac")).getByRole("button", { name: "Collapse This Mac" }));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);

    expect(within(hostSection("This Mac")).queryByText("app thread 1")).toBeNull();
    expect(within(hostSection("mac-mini")).getByText("api thread 1")).toBeInTheDocument();
    expect(within(hostSection("This Mac")).getByRole("button", { name: "Expand This Mac" })).toHaveAttribute("aria-expanded", "false");
    expect(visibleThreads(useAppStore.getState()).map((t) => t.id)).toEqual(["api-t1"]);
    await waitFor(() => expect(backend.saves.at(-1)?.collapsedHosts).toEqual(["local"]));

    fireEvent.click(within(hostSection("This Mac")).getByRole("button", { name: "Expand This Mac" }));
    expect(within(hostSection("This Mac")).getByText("app thread 1")).toBeInTheDocument();
    await waitFor(() => expect(backend.saves.at(-1)?.collapsedHosts).toEqual([]));
  });

  it("with only This Mac, keeps the single Projects list", async () => {
    resetBackend(stateWith([project("app")]));
    await renderApp();
    expect(within(sidebar()).queryByRole("region", { name: "This Mac" })).toBeNull();
    expect(within(sidebar()).getByText("app")).toBeInTheDocument();
  });

  it("adds a project on a remote host from that host's folders", async () => {
    twoHosts(MINI_UP);
    backend.projectFiles = { "Users/me/web/index.ts": "", "Users/me/notes/a.md": "" };
    await renderApp();
    fireEvent.click(await waitFor(() => within(hostSection("mac-mini")).getByRole("button", { name: "Add Project Folder on mac-mini…" })));

    const dialog = await screen.findByRole("dialog", { name: "Add Project on mac-mini" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "web" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add web" }));

    await waitFor(() => expect(callsTo("project_add")).toHaveLength(1));
    expect(callsTo("project_add")[0]).toMatchObject({ host: "mac-mini", args: { path: "/Users/me/web", name: "web" } });
    expect(useAppStore.getState().projects.find((p) => p.path === "/Users/me/web")?.hostKey).toBe("mac-mini");
  });

  it("opens a remote project as a VS Code remote window on its host", async () => {
    twoHosts(MINI_UP);
    await renderApp();
    const header = await waitFor(() => within(hostSection("mac-mini")).getByText("api").closest<HTMLElement>(".project-header")!);
    fireEvent.contextMenu(header);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in VS Code" }));
    await waitFor(() => expect(callsTo("open_in_vscode").map((c) => c.args)).toEqual([{ path: "/Users/me/api", host: "mac-mini" }]));
  });

  it("disables the composer, with a banner, while the thread's host is away", async () => {
    twoHosts(MINI_DOWN);
    await renderApp();
    fireEvent.click(await waitFor(() => within(hostSection("mac-mini")).getByText("api thread 1")));
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("mac-mini is reconnecting. Messages and prompts wait until it's back.");
    expect(screen.getByRole("textbox", { name: "Message input" })).toBeDisabled();
  });
});

describe("hosts in Settings", () => {
  it("offers a token for a host whose agent can't reach the login Keychain", async () => {
    twoHosts(MINI_UP);
    backend.setupByHost["mac-mini"] = { ...readySetup, status: "not_logged_in", message: "Run claude /login", launchDomain: "background", tokenPresent: false };
    await renderApp();
    useAppStore.getState().setSettingsOpen(true);
    fireEvent.click(await screen.findByRole("tab", { name: "Hosts" }));
    const hosts = await screen.findByRole("list", { name: "Hosts" });
    const token = await within(hosts).findByLabelText("Claude token for mac-mini");
    fireEvent.change(token, { target: { value: "sk-ant-oat-123" } });
    fireEvent.click(within(hosts).getByRole("button", { name: "Save Token" }));
    await waitFor(() => expect(callsTo("set_claude_token")).toHaveLength(1));
    expect(callsTo("set_claude_token")[0]).toMatchObject({ host: "mac-mini", args: { token: "sk-ant-oat-123" } });
  });
});

describe("file, git and worktree calls go to the thread's or project's host", () => {
  it("routes a remote worktree thread's explorer and git calls to its host", async () => {
    // The worktree sits under the host's state dir, outside every project folder.
    const worktree = { path: "/Users/me/.speedy/worktrees/api/wt1", branch: "speedy/wt1" };
    resetBackend(stateWith([project("app"), project("api", [{ worktree }], { hostKey: "mac-mini", path: "/Users/me/api" })], "api-t1"));
    backend.extraHosts = [{ key: "mac-mini", state: MINI_UP }];
    backend.projectFiles = { "README.md": "# Hi\n" };
    await renderApp();
    await waitFor(() => expect(backend.listeners.menu?.length).toBeTruthy());
    act(() => emitMenu("toggle_explorer"));
    await within(await screen.findByRole("tree", { name: "Files in api" })).findByText("README.md");

    for (const cmd of ["explorer_list", "explorer_git_status", "explorer_git_branch"]) {
      await waitFor(() => expect(callsTo(cmd).length).toBeGreaterThan(0));
      expect(callsTo(cmd).map((c) => [c.host, c.args?.root])).toEqual(callsTo(cmd).map(() => ["mac-mini", worktree.path]));
    }
  });

  it("cleans up worktrees on the right host when two hosts have a project at the same path", async () => {
    const wt = (host: string) => ({ archived: true, worktree: { path: `/data/${host}/worktrees/done`, branch: "speedy/done" } });
    resetBackend(
      stateWith([
        project("app", [{}, wt("local")]),
        project("mini-app", [{}, wt("mini")], { hostKey: "mac-mini", path: "/Users/me/app" }),
      ]),
    );
    backend.extraHosts = [{ key: "mac-mini", state: MINI_UP }];
    backend.worktreeUnused = [{ path: "/data/mini/worktrees/done", branch: "speedy/done", dirty: false, merged: true }];
    backend.worktreeClean = { removed: ["/data/mini/worktrees/done"], skipped: [], deletedBranches: ["speedy/done"] };
    await renderApp();
    const header = await waitFor(() => within(hostSection("mac-mini")).getByText("mini-app").closest<HTMLElement>(".project-header")!);
    fireEvent.contextMenu(header);
    fireEvent.click(screen.getByRole("menuitem", { name: "Clean Up Worktrees…" }));

    await waitFor(() => expect(callsTo("worktree_clean")).toHaveLength(1));
    expect(callsTo("worktree_unused").map((c) => [c.host, c.args?.root])).toEqual([["mac-mini", "/Users/me/app"]]);
    expect(callsTo("worktree_clean")[0]).toMatchObject({ host: "mac-mini", args: { root: "/Users/me/app", paths: ["/data/mini/worktrees/done"] } });
  });
});

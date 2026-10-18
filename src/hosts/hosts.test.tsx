// U12: the host UI: a sidebar section per host, adding a project on a remote host, VS Code
// remote windows, the composer while a host is away, and the token fallback in Settings.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("../app/testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../app/testing/tauriMock")).dialogMock);

import { App } from "../app/App";
import { backend, callsTo, project, readySetup, stateWith } from "../app/testing/tauriMock";
import { resetBackend } from "../app/testing/reset";
import { useAppStore } from "../store/appStore";

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
    const hosts = await screen.findByRole("list", { name: "Hosts" });
    const token = await within(hosts).findByLabelText("Claude token for mac-mini");
    fireEvent.change(token, { target: { value: "sk-ant-oat-123" } });
    fireEvent.click(within(hosts).getByRole("button", { name: "Save Token" }));
    await waitFor(() => expect(callsTo("set_claude_token")).toHaveLength(1));
    expect(callsTo("set_claude_token")[0]).toMatchObject({ host: "mac-mini", args: { token: "sk-ant-oat-123" } });
  });
});

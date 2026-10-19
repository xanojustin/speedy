import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("./testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("./testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("./testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("./testing/tauriMock")).dialogMock);

import { App } from "./App";
import { backend, callsTo, lastSaved, readySetup } from "./testing/tauriMock";
import { resetBackend } from "./testing/reset";

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("Setup gating", () => {
  it("blocks on cli_not_found with the searched paths, and Recheck uses the override path", async () => {
    backend.setup = {
      ...readySetup,
      status: "cli_not_found",
      claudePath: null,
      claudeVersion: null,
      searchedPaths: ["/opt/homebrew/bin", "/Users/me/.local/bin"],
    };
    render(<App />);
    await screen.findByRole("heading", { name: "Claude Code CLI not found" });
    expect(screen.getByText("/opt/homebrew/bin")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/.local/bin")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Projects" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Path to claude" }), { target: { value: "/custom/claude" } });
    backend.setup = readySetup;
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));

    await screen.findByRole("navigation", { name: "Projects" });
    expect(callsTo("recheck_setup").map((c) => c.args)).toEqual([{ overridePath: "/custom/claude" }]);
    expect(lastSaved()!.claudePathOverride).toBe("/custom/claude");
  });

  it("tells a logged-out user to run claude auth login", async () => {
    backend.setup = { ...readySetup, status: "not_logged_in" };
    render(<App />);
    await screen.findByRole("heading", { name: "Not logged in to Claude Code" });
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
  });

  it("applies a saved override path at launch", async () => {
    resetBackend({ version: 1, projects: [], groups: [], selectedThreadId: null, claudePathOverride: "/custom/claude", sidebarWidth: 260, notificationsEnabled: true, completionSound: null, activityPanelVisible: false, collapsedHosts: [], theme: "system" });
    backend.setup = { ...readySetup, status: "cli_not_found" };
    const real = backend.setup;
    render(<App />);
    await waitFor(() => expect(callsTo("recheck_setup")).toHaveLength(1));
    expect(callsTo("recheck_setup")[0].args).toEqual({ overridePath: "/custom/claude" });
    expect(real.status).toBe("cli_not_found");
  });

  it("shows a loading state while setup is resolving", async () => {
    let resolve!: (v: unknown) => void;
    const { invoke } = await import("./testing/tauriMock");
    // Everything answers as usual except the setup check, which waits.
    const usual = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "host_call" && args?.method === "get_setup_state" ? new Promise((r) => (resolve = r)) : usual(cmd, args),
    );
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent(/Starting/);
    resolve(readySetup);
    await screen.findByRole("navigation", { name: "Projects" });
    invoke.mockImplementation(usual);
  });

  it("shows dismissible banners for a CLI version mismatch and a moved-aside state file", async () => {
    backend.setup = { ...readySetup, claudeVersion: "2.2.0", fixtureVersion: "2.1.296", versionMismatch: true };
    backend.notice = "Your saved state was unreadable and was moved to state.json.corrupt.";
    render(<App />);
    await screen.findByRole("navigation", { name: "Projects" });
    expect(screen.getByText(/Installed CLI 2\.2\.0 differs from tested 2\.1\.296; run the protocol drift test/)).toBeInTheDocument();
    expect(screen.getByText(/state\.json\.corrupt/)).toBeInTheDocument();

    for (const btn of screen.getAllByRole("button", { name: "Dismiss" })) fireEvent.click(btn);
    expect(screen.queryByText(/differs from tested/)).toBeNull();
    expect(screen.queryByText(/state\.json\.corrupt/)).toBeNull();
  });
});

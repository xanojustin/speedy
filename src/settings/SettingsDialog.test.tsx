import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("../app/testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../app/testing/tauriMock")).dialogMock);

import { App } from "../app/App";
import { backend, callsTo, emitMenu, emptyState, lastSaved } from "../app/testing/tauriMock";
import { resetBackend } from "../app/testing/reset";

async function renderApp() {
  render(<App />);
  await screen.findByRole("navigation", { name: "Projects" });
  await waitFor(() => expect(backend.listeners.menu?.length).toBeTruthy());
}

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("settings", () => {
  it("opens from the menu and closes with Escape", async () => {
    await renderApp();
    act(() => emitMenu("open_settings"));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("splits into Settings, Hosts and Pinned Commands tabs", async () => {
    await renderApp();
    act(() => emitMenu("open_settings"));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Settings", "Hosts", "Pinned Commands"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel", { name: "Settings" })).toContainElement(within(dialog).getByRole("radiogroup", { name: /Theme/ }));
    expect(within(dialog).queryByRole("list", { name: "Hosts" })).toBeNull();

    fireEvent.click(tabs[1]);
    expect(within(dialog).getByRole("tabpanel", { name: "Hosts" })).toContainElement(within(dialog).getByRole("list", { name: "Hosts" }));
    expect(within(dialog).queryByRole("radiogroup", { name: /Theme/ })).toBeNull();

    // Arrow keys move along the strip, wrapping at the ends.
    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(within(dialog).getByRole("tab", { name: "Pinned Commands" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tab", { name: "Pinned Commands" })).toHaveFocus();
    expect(within(dialog).getByRole("table", { name: "Pinned commands" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(within(dialog).getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  });

  it("pushes saved prefs to the attention service at startup", async () => {
    resetBackend({ ...emptyState(), notificationsEnabled: false, completionSound: "Glass" });
    await renderApp();
    await waitFor(() => expect(callsTo("attention_set_prefs").at(-1)?.args).toEqual({ notifications: false, sound: "Glass" }));
  });

  it("picks Light, Dark or System Setting, applying it to the app and saving it", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const group = await screen.findByRole("radiogroup", { name: /Theme/ });
    expect(screen.getAllByRole("radio").map((r) => r.parentElement!.textContent)).toEqual(["Light", "Dark", "System Setting"]);
    expect(screen.getByRole("radio", { name: "System Setting" })).toBeChecked();
    expect(group).toBeInTheDocument();
    await waitFor(() => expect(callsTo("plugin:app|set_app_theme").at(-1)?.args).toEqual({ theme: null }));

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    await waitFor(() => expect(callsTo("plugin:app|set_app_theme").at(-1)?.args).toEqual({ theme: "dark" }));
    expect(lastSaved()!.theme).toBe("dark");

    fireEvent.click(screen.getByRole("radio", { name: "System Setting" }));
    await waitFor(() => expect(callsTo("plugin:app|set_app_theme").at(-1)?.args).toEqual({ theme: null }));
    expect(lastSaved()!.theme).toBe("system");
  });

  it("applies the saved theme at startup", async () => {
    resetBackend({ ...emptyState(), theme: "light" });
    await renderApp();
    await waitFor(() => expect(callsTo("plugin:app|set_app_theme").at(-1)?.args).toEqual({ theme: "light" }));
    expect(localStorage.getItem("speedy.theme")).toBe("light");
  });

  it("toggles notifications and picks an attention sound", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });

    fireEvent.click(screen.getByRole("checkbox", { name: /Show notifications/ }));
    await waitFor(() => expect(callsTo("attention_set_prefs").at(-1)?.args).toEqual({ notifications: false, sound: null }));
    expect(lastSaved()?.notificationsEnabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Attention sound"), { target: { value: "Tink" } });
    await waitFor(() => expect(callsTo("attention_set_prefs").at(-1)?.args).toEqual({ notifications: false, sound: "Tink" }));
    expect(lastSaved()?.completionSound).toBe("Tink");
    expect(callsTo("play_sound").at(-1)?.args).toEqual({ name: "Tink" });

    fireEvent.change(screen.getByLabelText("Attention sound"), { target: { value: "" } });
    expect(lastSaved()?.completionSound).toBeNull();
    expect(screen.getByRole("button", { name: "Play sound" })).toBeDisabled();
  });
});

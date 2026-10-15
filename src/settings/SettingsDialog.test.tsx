import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("pushes saved prefs to the attention service at startup", async () => {
    resetBackend({ ...emptyState(), notificationsEnabled: false, completionSound: "Glass" });
    await renderApp();
    await waitFor(() => expect(callsTo("attention_set_prefs").at(-1)?.args).toEqual({ notifications: false, sound: "Glass" }));
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

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("./testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("./testing/tauriMock")).eventMock);
vi.mock("@tauri-apps/api/webview", async () => (await import("./testing/tauriMock")).webviewMock);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("./testing/tauriMock")).dialogMock);

import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { App } from "./App";
import { backend, callsTo, project, stateWith } from "./testing/tauriMock";
import { resetBackend, runtime } from "./testing/reset";

const sidebar = () => screen.getByRole("navigation", { name: "Projects" });
const threadRow = (title: string) => within(sidebar()).getByText(title).closest<HTMLElement>("[role=treeitem]")!;

function emit(event: string, payload: unknown) {
  act(() => {
    for (const h of backend.listeners[event] ?? []) h({ payload });
  });
}

async function renderApp() {
  render(<App />);
  await screen.findByRole("navigation", { name: "Projects" });
  await waitFor(() => expect(backend.listeners["attention-unread"]?.length).toBeTruthy());
  await waitFor(() => expect(backend.listeners["attention-open-thread"]?.length).toBeTruthy());
}

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("attention", () => {
  it("reports the selected thread as visible and marks it read", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t1"));
    await renderApp();
    await waitFor(() => expect(callsTo("attention_set_visible").at(-1)?.args).toEqual({ threadId: "app-t1" }));
    expect(callsTo("attention_mark_read").at(-1)?.args).toEqual({ threadId: "app-t1" });

    fireEvent.click(threadRow("app thread 2"));
    await waitFor(() => expect(callsTo("attention_set_visible").at(-1)?.args).toEqual({ threadId: "app-t2" }));
    expect(callsTo("attention_mark_read").at(-1)?.args).toEqual({ threadId: "app-t2" });

    act(() => useAppStore.getState().selectThread(null));
    await waitFor(() => expect(callsTo("attention_set_visible").at(-1)?.args).toEqual({ threadId: null }));
  });

  it("reports thread titles so notifications can name the thread", async () => {
    resetBackend(stateWith([project("app", [{ title: "Fix login" }])], null));
    await renderApp();
    await waitFor(() => expect(callsTo("attention_set_titles").at(-1)?.args).toEqual({ titles: { "app-t1": "Fix login" } }));
  });

  it("shows the unread glyph for threads in an attention-unread event", async () => {
    resetBackend(stateWith([project("app", [{}, {}])], "app-t1"));
    useThreadStore.setState({ threads: { "app-t2": runtime("idle") } });
    await renderApp();
    expect(within(threadRow("app thread 2")).getByRole("img")).toHaveAccessibleName("Idle");

    emit("attention-unread", { unread: ["app-t2"] });
    expect(within(threadRow("app thread 2")).getByRole("img")).toHaveAccessibleName("Finished, unread");

    emit("attention-unread", { unread: [] });
    expect(within(threadRow("app thread 2")).getByRole("img")).toHaveAccessibleName("Idle");
  });

  it("selects the thread from an attention-open-thread event, expanding its project", async () => {
    resetBackend(stateWith([project("app"), project("api", [{}], { collapsed: true })], "app-t1"));
    await renderApp();
    expect(within(sidebar()).queryByText("api thread 1")).toBeNull();

    emit("attention-open-thread", { threadId: "api-t1" });
    expect(useAppStore.getState().selectedThreadId).toBe("api-t1");
    expect(threadRow("api thread 1")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(callsTo("attention_mark_read").at(-1)?.args).toEqual({ threadId: "api-t1" }));
  });
});

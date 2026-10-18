// U11: SSH passphrase and 2FA prompts raised by ssh's askpass helper, answered in the app.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../app/testing/tauriMock")).coreMock);
vi.mock("@tauri-apps/api/event", async () => (await import("../app/testing/tauriMock")).eventMock);

import { backend, callsTo } from "../app/testing/tauriMock";
import { resetBackend } from "../app/testing/reset";
import { AskpassDialog } from "./AskpassDialog";

/** Rust's `askpass` event, as the helper's prompt reaches the webview. */
function ask(id: number, host: string, prompt: string) {
  act(() => {
    for (const h of backend.listeners.askpass ?? []) h({ payload: { id, host, prompt } });
  });
}

async function renderDialog() {
  render(<AskpassDialog />);
  await waitFor(() => expect(backend.listeners.askpass).toHaveLength(1));
}

beforeEach(() => resetBackend());
afterEach(cleanup);

describe("the SSH prompt dialog", () => {
  it("shows nothing until ssh asks", async () => {
    await renderDialog();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the host and prompt, and sends what was typed to that prompt", async () => {
    await renderDialog();
    ask(7, "mac-mini", "Enter passphrase for key '/Users/me/.ssh/id_ed25519':");

    const dialog = screen.getByRole("dialog", { name: "SSH to mac-mini" });
    expect(dialog).toHaveTextContent("Enter passphrase for key '/Users/me/.ssh/id_ed25519':");
    const input = screen.getByLabelText("Enter passphrase for key '/Users/me/.ssh/id_ed25519':");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(callsTo("askpass_answer").map((c) => c.args)).toEqual([{ id: 7, answer: "hunter2" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel refuses the prompt", async () => {
    await renderDialog();
    ask(3, "local", "Password:");
    expect(screen.getByRole("dialog", { name: "SSH to This Mac" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(callsTo("askpass_answer").map((c) => c.args)).toEqual([{ id: 3, answer: null }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape refuses the prompt too", async () => {
    await renderDialog();
    ask(4, "mac-mini", "Password:");
    fireEvent.keyDown(screen.getByLabelText("Password:"), { key: "Escape" });
    expect(callsTo("askpass_answer").map((c) => c.args)).toEqual([{ id: 4, answer: null }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("queues a second prompt behind the first, starting with an empty field", async () => {
    await renderDialog();
    ask(1, "mac-mini", "Enter passphrase:");
    ask(2, "mac-mini", "Verification code:");
    fireEvent.change(screen.getByLabelText("Enter passphrase:"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const code = screen.getByLabelText("Verification code:");
    expect(code).toHaveValue("");
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(callsTo("askpass_answer").map((c) => c.args)).toEqual([
      { id: 1, answer: "pw" },
      { id: 2, answer: "123456" },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

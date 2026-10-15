import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { claudeControl } from "./commands";

describe("ipc commands", () => {
  it("passes camelCase args through to the Rust command", async () => {
    invoke.mockResolvedValue({ ok: true });
    await claudeControl("t1", { subtype: "set_model", model: "opus" });
    expect(invoke).toHaveBeenCalledWith("claude_control", {
      threadId: "t1",
      request: { subtype: "set_model", model: "opus" },
      timeoutMs: null,
    });
  });
});

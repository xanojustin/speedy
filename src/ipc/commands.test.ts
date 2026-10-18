import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { claudeControl, explorerList, setHostLookup } from "./commands";

describe("ipc commands", () => {
  it("routes a thread call to its host as the agent method with camelCase params", async () => {
    invoke.mockResolvedValue({ ok: true });
    await claudeControl("t1", { subtype: "set_model", model: "opus" });
    expect(invoke).toHaveBeenCalledWith("host_call", {
      host: "local",
      method: "claude_control",
      params: { threadId: "t1", request: { subtype: "set_model", model: "opus" }, timeoutMs: null },
    });
  });

  it("asks the app store which host owns a thread or path", async () => {
    invoke.mockResolvedValue([]);
    setHostLookup(({ threadId, path }) => (threadId === "t9" || path?.startsWith("/mini/") ? "mac-mini" : undefined));
    await claudeControl("t9", { subtype: "interrupt" });
    await explorerList("/mini/repo", "src");
    await explorerList("/laptop/repo", "src");
    const hosts = invoke.mock.calls.slice(-3).map((c) => (c[1] as { host: string }).host);
    expect(hosts).toEqual(["mac-mini", "mac-mini", "local"]);
  });
});

// Streaming code blocks keep their highlighted rendering while new tokens arrive.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("./highlight", () => ({
  highlight: vi.fn(async (code: string, lang: string | undefined) => (lang ? `<pre class="shiki" data-lang="${lang}"><code>${esc(code)}</code></pre>` : null)),
}));

import { highlight } from "./highlight";
import { Markdown } from "./Markdown";

const fence = (code: string, lang = "ts") => "```" + lang + "\n" + code + "\n```";
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(highlight).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CodeBlock highlighting while streaming", () => {
  it("keeps the highlighted element across a code update, then shows the new code", async () => {
    const { container, rerender } = render(<Markdown text={fence("const a = 1;")} />);
    await tick(200);
    expect(container.querySelector(".md-shiki")?.textContent).toBe("const a = 1;");

    rerender(<Markdown text={fence("const a = 1;\nconst b")} />);
    // No plain-<pre> frame: the previous highlight stays until the new one resolves.
    expect(container.querySelector(".md-shiki")).not.toBeNull();
    expect(container.querySelector(".md-code-block > pre")).toBeNull();

    await tick(200);
    expect(container.querySelector(".md-shiki")?.textContent).toBe("const a = 1;\nconst b");
  });

  it("re-highlights during a continuous stream instead of waiting for it to pause", async () => {
    let code = "let x = 0;";
    const { container, rerender } = render(<Markdown text={fence(code)} />);
    await tick(200);
    const before = vi.mocked(highlight).mock.calls.length;

    // A token every 20 ms for 400 ms: a per-delta debounce would never fire.
    for (let i = 0; i < 20; i++) {
      code += `\nx += ${i};`;
      rerender(<Markdown text={fence(code)} />);
      expect(container.querySelector(".md-shiki")).not.toBeNull();
      await tick(20);
    }
    expect(vi.mocked(highlight).mock.calls.length - before).toBeGreaterThanOrEqual(3);
    expect(container.querySelector(".md-shiki")?.textContent).toContain("x += 10;");
  });

  it("does not show another language's highlight", async () => {
    const { container, rerender } = render(<Markdown text={fence("print(1)", "ts")} />);
    await tick(200);
    expect(container.querySelector(".md-shiki pre")?.getAttribute("data-lang")).toBe("ts");

    rerender(<Markdown text={fence("print(1)", "python")} />);
    expect(container.querySelector(".md-shiki pre[data-lang='ts']")).toBeNull();
    await tick(200);
    expect(container.querySelector(".md-shiki pre")?.getAttribute("data-lang")).toBe("python");
  });
});

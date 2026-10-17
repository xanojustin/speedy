import { describe, expect, it } from "vitest";
import { MAX_SNIPPET_CHARS, makeSnippet, snippetPrompt } from "./snippets";

describe("makeSnippet", () => {
  it("drops xterm's trailing padding and blank edge lines", () => {
    const s = makeSnippet("\n\n$ bun test   \nFAIL  src/a.test.ts  \n\n", "Terminal 1");
    expect(s?.text).toBe("$ bun test\nFAIL  src/a.test.ts");
    expect(s?.lines).toBe(2);
  });

  it("returns null for a whitespace-only selection", () => {
    expect(makeSnippet("   \n \n", "Terminal 1")).toBeNull();
  });

  it("keeps the tail of very long output", () => {
    const raw = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    const s = makeSnippet(raw, "Terminal 1")!;
    expect(s.text.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 40);
    expect(s.text.startsWith("[… earlier output trimmed]\nline ")).toBe(true);
    expect(s.text.endsWith("line 19999")).toBe(true);
    expect(s.lines).toBe(20_000);
  });
});

describe("snippetPrompt", () => {
  it("fences the output and names its terminal", () => {
    const s = makeSnippet("error: boom", "Terminal 2")!;
    expect(snippetPrompt(s)).toBe("Output from my terminal (Terminal 2):\n```\nerror: boom\n```");
  });

  it("uses a longer fence than any backtick run in the output", () => {
    const s = makeSnippet("```js\nx\n```", "Terminal 1")!;
    expect(snippetPrompt(s)).toBe("Output from my terminal (Terminal 1):\n````\n```js\nx\n```\n````");
  });
});

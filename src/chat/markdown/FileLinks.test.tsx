// File references in assistant prose link to the explorer.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { useAppStore } from "../../store/appStore";
import { Markdown } from "./Markdown";

afterEach(() => {
  cleanup();
  useAppStore.setState({ explorerOpen: false, explorerReveal: null });
});

describe("file links", () => {
  it("links inline code, prose, and path link targets to the explorer", () => {
    render(<Markdown text={"Fixed `src/a.ts:12`, see lib/b.rs:3 and [the plan](docs/plan.md#L7). Built with Node.js."} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["src/a.ts:12", "lib/b.rs:3", "the plan"]);

    fireEvent.click(links[0]);
    expect(useAppStore.getState()).toMatchObject({ explorerOpen: true, explorerReveal: { path: "src/a.ts", line: 12 } });
    fireEvent.click(links[2]);
    expect(useAppStore.getState().explorerReveal).toEqual({ path: "docs/plan.md", line: 7 });
  });

  it("doesn't nest a file link inside a web link", () => {
    render(<Markdown text={"[`src/a.ts`](https://example.com/src/a.ts)"} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/src/a.ts");
  });

  it("leaves fenced code alone", () => {
    render(<Markdown text={"```\nsrc/a.ts:1\n```"} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

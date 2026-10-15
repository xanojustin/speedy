import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

describe("highlight", () => {
  it("highlights with dark-plus/light-plus CSS variables using the JS regex engine, escaping the code", async () => {
    const html = await highlight('const s = "<script>alert(1)</script>";', "ts");
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("--shiki-light");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#x3C;script>");
  }, 20000);

  it("returns null for unknown languages so the plain block stays", async () => {
    expect(await highlight("x", "definitely-not-a-language")).toBeNull();
    expect(await highlight("x", undefined)).toBeNull();
  });
});

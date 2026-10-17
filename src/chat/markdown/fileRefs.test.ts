import { describe, expect, it } from "vitest";
import { parseFileHref, parseFileRef, splitFileRefs } from "./fileRefs";

describe("parseFileRef", () => {
  it.each([
    ["src/app/App.tsx", "src/app/App.tsx", null],
    ["src/app/App.tsx:42", "src/app/App.tsx", 42],
    ["src/app/App.tsx:42:7", "src/app/App.tsx", 42],
    ["src/app/App.tsx:42-60", "src/app/App.tsx", 42],
    ["src/app/App.tsx#L42", "src/app/App.tsx", 42],
    ["./scripts/reinstall.sh", "./scripts/reinstall.sh", null],
    ["/Users/me/proj/src/main.rs:3", "/Users/me/proj/src/main.rs", 3],
    [".github/workflows/ci.yml", ".github/workflows/ci.yml", null],
    ["Composer.tsx", "Composer.tsx", null],
    ["package.json:5", "package.json", 5],
    ["src-tauri/Cargo.toml", "src-tauri/Cargo.toml", null],
  ])("%s", (text, path, line) => {
    expect(parseFileRef(text)).toEqual({ path, line });
  });

  it.each(["Array.from", "foo.bar()", "v1.2.3", "useState", "npm run build", "e.g.", "a/b", "//cdn.example.com/x.js"])(
    "leaves %s alone",
    (text) => {
      expect(parseFileRef(text)).toBeNull();
    },
  );
});

describe("parseFileHref", () => {
  it("accepts paths and file URLs, not web links", () => {
    expect(parseFileHref("src/a.ts#L10")).toEqual({ path: "src/a.ts", line: 10 });
    expect(parseFileHref("file:///Users/me/p/a%20b/c.ts")).toBeNull(); // spaces never form a path
    expect(parseFileHref("file:///Users/me/p/c.ts")).toEqual({ path: "/Users/me/p/c.ts", line: null });
    expect(parseFileHref("https://example.com/a.ts")).toBeNull();
    expect(parseFileHref("mailto:a@b.co")).toBeNull();
  });
});

describe("splitFileRefs", () => {
  it("finds references in prose", () => {
    expect(splitFileRefs("See src/app/App.tsx:42 and lib/x.rs.")).toEqual([
      "See ",
      { text: "src/app/App.tsx:42", ref: { path: "src/app/App.tsx", line: 42 } },
      " and ",
      { text: "lib/x.rs", ref: { path: "lib/x.rs", line: null } },
      ".",
    ]);
  });

  it("links a bare name only when it has a line number", () => {
    expect(splitFileRefs("Edit package.json first")).toEqual(["Edit package.json first"]);
    expect(splitFileRefs("(Composer.tsx:12)")).toEqual(["(", { text: "Composer.tsx:12", ref: { path: "Composer.tsx", line: 12 } }, ")"]);
  });

  it("ignores prose that only looks like a file", () => {
    for (const s of ["Built with Node.js and React.", "Use e.g. this", "Version 1.2.3/4.5 shipped", "and/or"]) {
      expect(splitFileRefs(s)).toEqual([s]);
    }
  });

  it("doesn't cut a name short", () => {
    expect(splitFileRefs("src/a.test.tsx:9: failed")).toEqual([
      { text: "src/a.test.tsx:9", ref: { path: "src/a.test.tsx", line: 9 } },
      ": failed",
    ]);
  });
});

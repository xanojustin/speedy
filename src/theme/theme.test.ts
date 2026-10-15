import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(resolve(__dirname, name), "utf8");

/** Every --vscode-* custom property the file declares. */
function declaredVars(css: string) {
  return new Set([...css.matchAll(/(--vscode-[\w-]+)\s*:/g)].map((m) => m[1]));
}

describe("VS Code theme tokens", () => {
  const dark = read("vscode-dark-modern.css");
  const light = read("vscode-light-modern.css");
  const index = read("index.css");
  const extensionVars: string[] = JSON.parse(read("extension-vars.json"));

  it("loads both token sets, dark as the default and light gated by the system appearance", () => {
    const imports = [...index.matchAll(/@import\s+["']\.\/(vscode-[\w-]+\.css)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["vscode-dark-modern.css", "vscode-light-modern.css"]);

    expect(dark.trimStart().startsWith("/*")).toBe(true);
    expect(dark).not.toMatch(/@media/);
    expect(dark).toMatch(/:root\s*\{[^}]*--vscode-editor-background:\s*#1f1f1f;/);

    const lightBody = light.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(lightBody).toMatch(/^@media \(prefers-color-scheme: light\) \{\s*:root \{/);
    expect(lightBody).toMatch(/--vscode-editor-background:\s*#ffffff;/);
    // Nothing in the light file escapes the media query.
    expect(lightBody.endsWith("}\n  }\n}") || lightBody.endsWith("}\n}")).toBe(true);
  });

  it("defines every --vscode-* name the extension stylesheet references, in both themes", () => {
    expect(extensionVars).toHaveLength(258);
    for (const css of [dark, light]) {
      const declared = declaredVars(css);
      const missing = extensionVars.filter((n) => !declared.has(`--vscode-${n}`));
      expect(missing).toEqual([]);
    }
  });

  it("includes the font and terminal variables", () => {
    for (const css of [dark, light]) {
      expect(css).toContain("--vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;");
      expect(css).toContain("--vscode-font-size: 13px;");
      expect(css).toContain("--vscode-editor-font-family: Menlo, Monaco, 'Courier New', monospace;");
      expect(css).toContain("--vscode-editor-font-size: 12px;");
      for (const name of ["terminal-background", "terminal-foreground", "terminalCursor-foreground", "terminal-ansiBrightWhite"]) {
        expect(css).toMatch(new RegExp(`--vscode-${name}: #[0-9a-f]{6,8};`));
      }
    }
  });

  it("styles the body like the extension panel", () => {
    expect(index).toMatch(/body\s*\{[^}]*background(-color)?:\s*var\(--vscode-sideBar-background\)/);
    expect(index).toMatch(/body\s*\{[^}]*color:\s*var\(--vscode-foreground\)/);
    expect(index).toMatch(/body\s*\{[^}]*font-family:\s*var\(--vscode-font-family\)/);
  });
});

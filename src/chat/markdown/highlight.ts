// Lazy Shiki highlighting with the VS Code Dark+/Light+ themes. Uses Shiki's JavaScript regex
// engine: the production CSP forbids the Oniguruma WASM engine.
import type { HighlighterCore } from "shiki/core";

let highlighter: Promise<HighlighterCore> | null = null;
const failedLangs = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/dark-plus.mjs"), import("shiki/themes/light-plus.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighter;
}

const ALIASES: Record<string, string> = { sh: "bash", zsh: "bash", shell: "bash", console: "bash", js: "javascript", ts: "typescript", py: "python", rb: "ruby", yml: "yaml", md: "markdown" };

/**
 * Highlighted HTML for `code` (Shiki escapes the code itself), or null for unknown languages or
 * failures, in which case the caller keeps the plain escaped rendering. Colors come out as
 * `--shiki-light` / `--shiki-dark` CSS variables so the CSS can follow `prefers-color-scheme`.
 */
export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  const raw = (lang ?? "").trim().toLowerCase().split(/\s+/)[0];
  if (!raw) return null;
  const id = ALIASES[raw] ?? raw;
  if (failedLangs.has(id)) return null;
  try {
    const { bundledLanguages } = await import("shiki/langs");
    const loader = (bundledLanguages as Record<string, unknown>)[id];
    if (!loader) {
      failedLangs.add(id);
      return null;
    }
    const h = await getHighlighter();
    if (!h.getLoadedLanguages().includes(id)) await h.loadLanguage(loader as Parameters<HighlighterCore["loadLanguage"]>[0]);
    return h.codeToHtml(code, { lang: id, themes: { light: "light-plus", dark: "dark-plus" }, defaultColor: false });
  } catch (err) {
    failedLangs.add(id);
    console.debug(`[speedy] highlighting ${id} failed`, err);
    return null;
  }
}

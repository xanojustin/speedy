// `src/a.ts:42`-style file references in model output, which the transcript links to the explorer.
// Pure and conservative: prose like "Node.js" or "e.g." must stay plain text.

export interface FileRef {
  path: string;
  line: number | null;
}

/** Bare names (no folder, no line) only count with one of these extensions. */
const KNOWN_EXT = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx rs go py rb php java kt kts swift c h cc cpp hpp m mm cs fs " +
    "css scss sass less html htm vue svelte astro yml yaml toml ini cfg conf env sh bash zsh fish sql " +
    "graphql gql proto xml plist lock txt csv gradle tf hcl lua dart ex exs erl hs ml scala clj zig nix"
  ).split(" "),
);

// A path: optional ./, ../ or /, folders, then a name with an extension that starts with a letter.
const PATH = String.raw`(?:\.{1,2}\/|\/)?(?:\.?[\w@+-][\w.@+-]*\/)*\.?[\w@+-][\w.@+-]*\.([A-Za-z][A-Za-z0-9]{0,9})`;
// :12, :12:5, :12-20, or GitHub's #L12 / #L12-L20.
const LINE = String.raw`(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)?`;

const WHOLE = new RegExp(`^(${PATH})${LINE}$`);
// In prose: bounded by whitespace or brackets/quotes; a trailing "." or ":" ends a sentence.
const IN_TEXT = new RegExp(String.raw`(^|[\s(\[{"'])(${PATH})${LINE}(?=$|[\s)\]}"',;!?]|[.:](?:\s|$))`, "g");

function toRef(path: string, ext: string, lineA: string | undefined, lineB: string | undefined, prose: boolean): FileRef | null {
  const lineText = lineA ?? lineB;
  const line = lineText ? Number(lineText) : null;
  const hasDir = path.includes("/");
  if (!hasDir && !KNOWN_EXT.has(ext.toLowerCase())) return null;
  // In prose a bare name needs a line number: "package.json" alone is usually just a mention.
  if (prose && !hasDir && line === null) return null;
  if (path.startsWith("//")) return null;
  return { path, line: line && line > 0 ? line : null };
}

/** The whole string as a file reference (inline code, a link target), or null. */
export function parseFileRef(text: string): FileRef | null {
  const s = text.trim();
  const m = WHOLE.exec(s);
  return m ? toRef(m[1], m[2], m[3], m[4], false) : null;
}

/** A link target as a file reference: a relative or absolute path, or a file:// URL. */
export function parseFileHref(href: string): FileRef | null {
  let s = href.trim();
  if (/^file:\/\//i.test(s)) s = s.slice("file://".length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  try {
    s = decodeURI(s);
  } catch {
    return null;
  }
  return parseFileRef(s);
}

export type TextPiece = string | { text: string; ref: FileRef };

/** Splits prose into plain runs and file references. */
export function splitFileRefs(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let at = 0;
  for (const m of text.matchAll(IN_TEXT)) {
    const ref = toRef(m[2], m[3], m[4], m[5], true);
    if (!ref) continue;
    const start = m.index + m[1].length;
    const end = m.index + m[0].length;
    if (start > at) out.push(text.slice(at, start));
    out.push({ text: text.slice(start, end), ref });
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

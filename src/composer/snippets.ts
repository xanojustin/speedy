// Terminal output attached to a message (Cmd+L over a terminal selection). Pure so it's testable.

/** Longer selections keep their tail: that's where the error usually is. */
export const MAX_SNIPPET_CHARS = 50_000;

export interface Snippet {
  id: string;
  /** "Terminal 2", or the shell's title. */
  source: string;
  text: string;
  lines: number;
}

/** Trims xterm's trailing padding and blank edge lines; null when nothing is left. */
export function makeSnippet(raw: string, source: string): Snippet | null {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  let text = lines.join("\n");
  if (text.length > MAX_SNIPPET_CHARS) {
    const tail = text.slice(-MAX_SNIPPET_CHARS);
    text = `[… earlier output trimmed]\n${tail.slice(tail.indexOf("\n") + 1)}`;
  }
  return { id: crypto.randomUUID(), source, text, lines: lines.length };
}

/** The snippet as it's sent: a fence long enough that backticks in the output can't close it. */
export function snippetPrompt(s: Snippet): string {
  const longest = Math.max(2, ...Array.from(s.text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `Output from my terminal (${s.source}):\n${fence}\n${s.text}\n${fence}`;
}

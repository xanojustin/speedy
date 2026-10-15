// U10: inline unified diff for Edit/Write/MultiEdit permission requests, syntax-highlighted with
// the transcript's Shiki highlighter. The diff text comes from the Rust side (diff.rs).
import { useEffect, useMemo, useState } from "react";
import type { FileDiff } from "../ipc/types";
import { highlight } from "../chat/markdown/highlight";

type DiffLineKind = "ctx" | "add" | "del";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

interface ParsedDiff {
  hunks: { header: string; lines: DiffLine[] }[];
  /** Non-diff body text (e.g. the "file too large" summary), shown as-is. */
  summary: string | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnified(unified: string): ParsedDiff {
  const hunks: ParsedDiff["hunks"] = [];
  const extra: string[] = [];
  let cur: ParsedDiff["hunks"][number] | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = unified.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) {
      if (!line.startsWith("--- ") && !line.startsWith("+++ ")) extra.push(line);
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") cur.lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
    else if (sign === "-") cur.lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
    else cur.lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  }
  return { hunks, summary: extra.length ? extra.join("\n") : null };
}

function langOf(path: string): string | undefined {
  const base = path.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/** Splits Shiki's `<pre><code><span class="line">…` output into per-line inner HTML. */
function shikiLines(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("code > .line")).map((el) => el.innerHTML);
}

/**
 * Highlights the old side (context + removed) and new side (context + added) separately, so
 * multi-line constructs tokenize as they would in each version of the file.
 */
function useHighlightedLines(parsed: ParsedDiff, lang: string | undefined): Map<DiffLine, string> | null {
  const [map, setMap] = useState<Map<DiffLine, string> | null>(null);
  useEffect(() => {
    setMap(null);
    if (!lang || parsed.hunks.length === 0) return;
    let live = true;
    const all = parsed.hunks.flatMap((h) => h.lines);
    const oldSide = all.filter((l) => l.kind !== "add");
    const newSide = all.filter((l) => l.kind !== "del");
    const side = async (lines: DiffLine[]) => {
      if (lines.length === 0) return [];
      const html = await highlight(lines.map((l) => l.text).join("\n"), lang);
      return html === null ? null : shikiLines(html);
    };
    void Promise.all([side(oldSide), side(newSide)]).then(([oldLines, newLines]) => {
      if (!live || oldLines === null || newLines === null) return;
      if (oldLines.length !== oldSide.length || newLines.length !== newSide.length) return;
      const out = new Map<DiffLine, string>();
      oldSide.forEach((l, i) => out.set(l, oldLines[i]));
      // Context lines take the new side's tokens.
      newSide.forEach((l, i) => out.set(l, newLines[i]));
      setMap(out);
    });
    return () => {
      live = false;
    };
  }, [parsed, lang]);
  return map;
}

export type FileVerdict = "accepted" | "rejected" | undefined;

function FileDiffView({
  diff,
  verdict,
  onVerdict,
}: {
  diff: FileDiff;
  verdict?: FileVerdict;
  onVerdict?: (v: "accepted" | "rejected") => void;
}) {
  const parsed = useMemo(() => parseUnified(diff.unified), [diff.unified]);
  const highlighted = useHighlightedLines(parsed, langOf(diff.path));
  const name = diff.path.split(/[/\\]/).pop() || diff.path;
  const dir = diff.path.slice(0, diff.path.length - name.length);
  const added = parsed.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0);
  const removed = parsed.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0);

  return (
    <div className="perm-diff-file" data-verdict={verdict}>
      <div className="perm-diff-header" title={diff.path}>
        <span className="perm-diff-name">{name}</span>
        <span className="perm-diff-dir">{dir}</span>
        {diff.isNewFile && <span className="perm-diff-badge">new file</span>}
        {parsed.hunks.length > 0 && (
          <span className="perm-diff-stat">
            <span className="perm-diff-stat-add">+{added}</span> <span className="perm-diff-stat-del">-{removed}</span>
          </span>
        )}
        {onVerdict && (
          <span className="perm-diff-verdict">
            <button
              type="button"
              className="perm-diff-verdict-btn"
              aria-pressed={verdict === "accepted"}
              aria-label={`Accept ${name}`}
              title={`Accept ${name}`}
              onClick={() => onVerdict("accepted")}
            >
              <span className="codicon codicon-check" />
            </button>
            <button
              type="button"
              className="perm-diff-verdict-btn"
              aria-label={`Reject ${name}`}
              title={`Reject ${name}`}
              onClick={() => onVerdict("rejected")}
            >
              <span className="codicon codicon-close" />
            </button>
          </span>
        )}
      </div>
      {parsed.summary !== null && <div className="perm-diff-summary">{parsed.summary}</div>}
      {parsed.hunks.length === 0 && parsed.summary === null && <div className="perm-diff-summary">No changes</div>}
      {parsed.hunks.length > 0 && (
        <div className="perm-diff-body">
          <table className="perm-diff-table">
            <tbody>
              {parsed.hunks.map((h, hi) => [
                hi > 0 ? (
                  <tr key={`sep-${hi}`} className="perm-diff-sep">
                    <td colSpan={4}>{h.header}</td>
                  </tr>
                ) : null,
                ...h.lines.map((l, li) => {
                  const html = highlighted?.get(l);
                  return (
                    <tr key={`${hi}-${li}`} className="perm-diff-line" data-kind={l.kind}>
                      <td className="perm-diff-old">{l.oldNo ?? ""}</td>
                      <td className="perm-diff-new">{l.newNo ?? ""}</td>
                      <td className="perm-diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</td>
                      {html !== undefined ? (
                        // Shiki escapes the source text; this is the same trust model as Markdown code blocks.
                        <td className="perm-diff-code shiki-line" dangerouslySetInnerHTML={{ __html: html }} />
                      ) : (
                        <td className="perm-diff-code">{l.text}</td>
                      )}
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DiffView({
  diffs,
  verdicts,
  onVerdict,
}: {
  diffs: FileDiff[];
  /** Per-file accept/reject, only for multi-file requests. */
  verdicts?: Record<string, FileVerdict>;
  onVerdict?: (path: string, v: "accepted" | "rejected") => void;
}) {
  const perFile = diffs.length > 1 && onVerdict;
  return (
    <div className="perm-diff">
      {diffs.map((d) => (
        <FileDiffView
          key={d.path}
          diff={d}
          verdict={perFile ? verdicts?.[d.path] : undefined}
          onVerdict={perFile ? (v) => onVerdict(d.path, v) : undefined}
        />
      ))}
    </div>
  );
}

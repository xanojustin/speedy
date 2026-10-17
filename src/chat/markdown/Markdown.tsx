// Model output is untrusted and this webview can reach a PTY. Markdown is lexed with `marked`
// (the extension's library) and rendered to React elements, never to an HTML string: raw HTML
// shows as literal text, only http(s) links are live, and they open through `open_path`.
// File references (`src/a.ts:42`) open in Speedy's own explorer, never through the OS.
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import { openPath } from "../../ipc/commands";
import { useAppStore } from "../../store/appStore";
import { parseFileHref, parseFileRef, splitFileRefs, type FileRef } from "./fileRefs";
import { highlight } from "./highlight";

export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function openLink(e: MouseEvent, href: string) {
  e.preventDefault();
  e.stopPropagation();
  void openPath(href).catch(() => {});
}

function FileLink({ fileRef, children }: { fileRef: FileRef; children: ReactNode }) {
  const where = `${fileRef.path}${fileRef.line ? `:${fileRef.line}` : ""}`;
  return (
    <a
      href="#"
      className="md-file-link"
      title={`Open ${where} in the Explorer`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        useAppStore.getState().revealInExplorer(fileRef.path, fileRef.line);
      }}
    >
      {children}
    </a>
  );
}

export function SafeLink({ href, title, children }: { href: string | null; title?: string | null; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) {
    const fileRef = href ? parseFileHref(href) : null;
    if (fileRef) return <FileLink fileRef={fileRef}>{children}</FileLink>;
    return <span className="md-link-inert">{children}</span>;
  }
  return (
    <a href={safe} title={title ?? safe} onClick={(e) => openLink(e, safe)}>
      {children}
    </a>
  );
}

/** Highlight at most this often while a code block streams (leading + trailing). */
const HIGHLIGHT_THROTTLE_MS = 100;

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  // The last highlight stays up until a newer one resolves, so streaming never flashes plain text.
  const [hl, setHl] = useState<{ html: string; lang: string | undefined } | null>(null);
  const [copied, setCopied] = useState(false);
  const runs = useRef({ started: 0, applied: 0, lastRun: -Infinity, mounted: true });
  useEffect(() => {
    const r = runs.current;
    r.mounted = true;
    return () => {
      r.mounted = false;
    };
  }, []);
  useEffect(() => {
    const r = runs.current;
    const run = () => {
      r.lastRun = Date.now();
      const id = ++r.started;
      void highlight(code, lang).then((h) => {
        // Drop results that resolve after unmount or after a newer run's result was applied.
        if (!r.mounted || id < r.applied) return;
        r.applied = id;
        setHl(h ? { html: h, lang } : null);
      });
    };
    const wait = r.lastRun + HIGHLIGHT_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      run();
      return;
    }
    const t = setTimeout(run, wait);
    return () => clearTimeout(t);
  }, [code, lang]);
  // Never show a highlight made for a different language.
  const html = hl && hl.lang === lang ? hl.html : null;

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="md-code-block">
      <button type="button" className="md-copy" title="Copy code" aria-label="Copy code" onClick={copy}>
        <i className={`codicon codicon-${copied ? "check" : "copy"}`} />
      </button>
      {html ? (
        // Shiki output is generated from the escaped code string.
        <div className="md-shiki" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/** `inLink`: inside a link's text, where file references must not nest another link. */
function inline(tokens: Token[] | undefined, key = "", inLink = false): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => renderInline(t, `${key}${i}`, inLink));
}

function renderInline(t: Token, key: string, inLink = false): ReactNode {
  switch (t.type) {
    case "text": {
      const tt = t as Tokens.Text;
      if (tt.tokens?.length) return <span key={key}>{inline(tt.tokens, `${key}.`, inLink)}</span>;
      return inLink ? decode(tt.text, key) : linkified(tt.text, key);
    }
    case "escape":
      return decode((t as Tokens.Escape).text, key);
    case "strong":
      return <strong key={key}>{inline((t as Tokens.Strong).tokens, `${key}.`, inLink)}</strong>;
    case "em":
      return <em key={key}>{inline((t as Tokens.Em).tokens, `${key}.`, inLink)}</em>;
    case "del":
      return <del key={key}>{inline((t as Tokens.Del).tokens, `${key}.`, inLink)}</del>;
    case "codespan": {
      const code = <code key={key}>{(t as Tokens.Codespan).text}</code>;
      const fileRef = inLink ? null : parseFileRef((t as Tokens.Codespan).text);
      return fileRef ? (
        <FileLink key={key} fileRef={fileRef}>
          {code}
        </FileLink>
      ) : (
        code
      );
    }
    case "br":
      return <br key={key} />;
    case "link": {
      const l = t as Tokens.Link;
      return (
        <SafeLink key={key} href={l.href} title={l.title}>
          {inline(l.tokens, `${key}.`, true)}
        </SafeLink>
      );
    }
    case "image": {
      // No remote image loads from model output; show the alt text as a link instead.
      const im = t as Tokens.Image;
      return (
        <SafeLink key={key} href={im.href} title={im.title}>
          {im.text || im.href}
        </SafeLink>
      );
    }
    case "html":
    case "tag":
      return <span key={key}>{(t as Tokens.HTML).raw}</span>;
    case "checkbox":
      return <input key={key} type="checkbox" checked={(t as Tokens.Checkbox).checked} readOnly disabled />;
    default:
      return <span key={key}>{"raw" in t ? String(t.raw) : ""}</span>;
  }
}

// marked (v18) leaves token text unescaped; React escapes it when rendered as a text node.
function decode(s: string, key: string): ReactNode {
  return <span key={key}>{s}</span>;
}

/** Prose with its file references linked. */
function linkified(s: string, key: string): ReactNode {
  const pieces = splitFileRefs(s);
  if (pieces.length === 1 && typeof pieces[0] === "string") return decode(s, key);
  return (
    <span key={key}>
      {pieces.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <FileLink key={i} fileRef={p.ref}>
            {p.text}
          </FileLink>
        ),
      )}
    </span>
  );
}

function renderBlock(t: Token, key: string): ReactNode {
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens, `${key}.`)}</p>;
    case "heading": {
      const h = t as Tokens.Heading;
      const Tag = `h${Math.min(Math.max(h.depth, 1), 6)}` as "h1";
      return <Tag key={key}>{inline(h.tokens, `${key}.`)}</Tag>;
    }
    case "code": {
      const c = t as Tokens.Code;
      return <CodeBlock key={key} code={c.text} lang={c.lang} />;
    }
    case "blockquote":
      return <blockquote key={key}>{blocks((t as Tokens.Blockquote).tokens, `${key}.`)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "list": {
      const l = t as Tokens.List;
      const items = l.items.map((it, i) => (
        <li key={i} className={it.task ? "md-task" : undefined}>
          {blocks(it.tokens, `${key}.${i}.`)}
        </li>
      ));
      return l.ordered ? (
        <ol key={key} start={typeof l.start === "number" && l.start !== 1 ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table": {
      const tb = t as Tokens.Table;
      const align = (a: string | null) => (a ? { textAlign: a as "left" } : undefined);
      return (
        <table key={key}>
          <thead>
            <tr>
              {tb.header.map((c, i) => (
                <th key={i} style={align(tb.align[i])}>
                  {inline(c.tokens, `${key}.h${i}.`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((row, r) => (
              <tr key={r}>
                {row.map((c, i) => (
                  <td key={i} style={align(tb.align[i])}>
                    {inline(c.tokens, `${key}.${r}.${i}.`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "html":
      return (
        <p key={key} className="md-raw-html">
          {(t as Tokens.HTML).raw}
        </p>
      );
    case "text": {
      // Block-level text (inside tight list items).
      const tt = t as Tokens.Text;
      return <span key={key}>{tt.tokens ? inline(tt.tokens, `${key}.`) : tt.text}</span>;
    }
    default:
      return renderInline(t, key);
  }
}

function blocks(tokens: Token[] | undefined, key = ""): ReactNode[] {
  return (tokens ?? []).map((t, i) => renderBlock(t, `${key}${i}`));
}

/**
 * One top-level token. While a message streams only its tail token's source changes, so the
 * blocks above it skip rendering. A token's output depends only on the token itself and the
 * document's reference-link definitions (`links`), which are compared too.
 */
const TopBlock = memo(
  function TopBlock({ token, index }: { token: Token; index: number; links: string }) {
    return <>{renderBlock(token, `${index}`)}</>;
  },
  (a, b) => a.index === b.index && a.links === b.links && a.token.type === b.token.type && a.token.raw === b.token.raw,
);

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const { tokens, links } = useMemo(() => {
    const tokens = Lexer.lex(text, { gfm: true, breaks: false });
    return { tokens, links: JSON.stringify(tokens.links ?? {}) };
  }, [text]);
  return (
    <div className={`md ${className ?? ""}`}>
      {tokens.map((t, i) => (
        <TopBlock key={i} token={t} index={i} links={links} />
      ))}
    </div>
  );
});

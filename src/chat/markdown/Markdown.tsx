// Model output is untrusted and this webview can reach a PTY. Markdown is lexed with `marked`
// (the extension's library) and rendered to React elements, never to an HTML string: raw HTML
// shows as literal text, only http(s) links are live, and they open through `open_path`.
import { memo, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import { openPath } from "../../ipc/commands";
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

export function SafeLink({ href, title, children }: { href: string | null; title?: string | null; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <span className="md-link-inert">{children}</span>;
  return (
    <a href={safe} title={title ?? safe} onClick={(e) => openLink(e, safe)}>
      {children}
    </a>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setHtml(null);
    // Debounce while streaming so each delta doesn't re-highlight.
    const t = setTimeout(() => {
      void highlight(code, lang).then((h) => {
        if (live) setHtml(h);
      });
    }, 60);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, lang]);

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

function inline(tokens: Token[] | undefined, key = ""): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => renderInline(t, `${key}${i}`));
}

function renderInline(t: Token, key: string): ReactNode {
  switch (t.type) {
    case "text": {
      const tt = t as Tokens.Text;
      return tt.tokens?.length ? <span key={key}>{inline(tt.tokens, `${key}.`)}</span> : decode(tt.text, key);
    }
    case "escape":
      return decode((t as Tokens.Escape).text, key);
    case "strong":
      return <strong key={key}>{inline((t as Tokens.Strong).tokens, `${key}.`)}</strong>;
    case "em":
      return <em key={key}>{inline((t as Tokens.Em).tokens, `${key}.`)}</em>;
    case "del":
      return <del key={key}>{inline((t as Tokens.Del).tokens, `${key}.`)}</del>;
    case "codespan":
      return <code key={key}>{(t as Tokens.Codespan).text}</code>;
    case "br":
      return <br key={key} />;
    case "link": {
      const l = t as Tokens.Link;
      return (
        <SafeLink key={key} href={l.href} title={l.title}>
          {inline(l.tokens, `${key}.`)}
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

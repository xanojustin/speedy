// A minimal file explorer for the selected thread's project: browse the tree, read and edit text
// files (Markdown previews rendered), and see uncommitted git changes against HEAD.
import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Markdown } from "../chat/markdown/Markdown";
import { highlight } from "../chat/markdown/highlight";
import { explorerGitDiff, explorerGitStatus, explorerList, explorerRead, explorerWrite, openInVscode } from "../ipc/commands";
import type { DirEntry, FileDiff, GitStatus } from "../ipc/types";
import { DiffView } from "../permissions/DiffView";
import { useAppStore } from "../store/appStore";
import { resolveReveal } from "./reveal";
import "../permissions/permissions.css";
import "./explorer.css";

/** How often git status is re-read while the explorer is open (Claude edits files under us). */
const STATUS_POLL_MS = 4000;
/** Larger files preview as plain text; Shiki is too slow on them. */
const MAX_HIGHLIGHT_CHARS = 200_000;

const STATUS_LABEL: Record<GitStatus, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
  C: "Conflict",
};

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
const extOf = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();

function useGitChanges(root: string) {
  const [changes, setChanges] = useState<Map<string, GitStatus>>(new Map());
  const refresh = useCallback(() => {
    void explorerGitStatus(root)
      .then((list) => setChanges(new Map(list.map((c) => [c.path, c.status]))))
      .catch(() => setChanges(new Map()));
  }, [root]);
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, STATUS_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  return { changes, refresh };
}

/** The status shown on a folder: its most notable descendant change. */
function folderStatus(changes: Map<string, GitStatus>, dir: string): GitStatus | undefined {
  const prefix = `${dir}/`;
  let found: GitStatus | undefined;
  for (const [path, status] of changes) {
    if (!path.startsWith(prefix)) continue;
    if (status === "C") return "C";
    if (status === "M" || !found) found = status;
  }
  return found;
}

/** An open file and the line to show; `seq` re-scrolls when the same line is asked for again. */
interface OpenFile {
  path: string;
  line: number | null;
  seq: number;
}

export function Explorer({ root, name, onClose }: { root: string; name: string; onClose: () => void }) {
  const { changes, refresh } = useGitChanges(root);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const openPath = open?.path ?? null;
  const setOpenPath = useCallback((path: string | null) => setOpen((prev) => (path === null ? null : { path, line: null, seq: (prev?.seq ?? 0) + 1 })), []);
  const [revealError, setRevealError] = useState<string | null>(null);
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const [treeVersion, setTreeVersion] = useState(0);
  // Lives here so expanded folders survive opening a file and going back.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleDir = useCallback((dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });
  }, []);

  const reload = () => {
    refresh();
    setTreeVersion((v) => v + 1);
  };

  // A file link clicked in the transcript.
  const reveal = useAppStore((s) => s.explorerReveal);
  useEffect(() => {
    if (!reveal) return;
    const target = useAppStore.getState().takeExplorerReveal();
    if (!target) return;
    void (async () => {
      const path = await resolveReveal(root, target.path);
      if (path === null) {
        setRevealError(`${target.path} is outside this thread's folder.`);
        return;
      }
      if (dirty.current && path !== openPath) {
        if (!(await ask("Discard unsaved changes?", { title: "Unsaved Changes", kind: "warning" }))) return;
      }
      setRevealError(null);
      setOpen((prev) => ({ path, line: target.line, seq: (prev?.seq ?? 0) + 1 }));
    })();
  }, [reveal, root, openPath]);

  return (
    <div className="explorer" aria-label="Explorer">
      <div className="panel-header explorer-header">
        <span className="panel-title" title={root}>
          Explorer: {name}
        </span>
        <span className="panel-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Open in VS Code"
            title="Open in VS Code"
            onClick={() => void openInVscode(root).catch((err) => console.warn("open_in_vscode failed", err))}
          >
            <span className="codicon codicon-vscode" aria-hidden />
          </button>
          {openPath === null && (
            <button type="button" className="icon-button" aria-label="Refresh Explorer" title="Refresh" onClick={reload}>
              <span className="codicon codicon-refresh" aria-hidden />
            </button>
          )}
          <button type="button" className="icon-button" aria-label="Hide Explorer" title="Hide Explorer (⇧⌘E)" onClick={onClose}>
            <span className="codicon codicon-close" aria-hidden />
          </button>
        </span>
      </div>
      {revealError && <div className="explorer-error">{revealError}</div>}
      {open !== null ? (
        <FileView
          key={open.path}
          root={root}
          path={open.path}
          line={open.line}
          seq={open.seq}
          status={changes.get(open.path)}
          onBack={() => setOpenPath(null)}
          onSaved={refresh}
          onDirty={onDirty}
        />
      ) : (
        <div className="explorer-tree" role="tree" aria-label={`Files in ${name}`}>
          <TreeLevel
            key={treeVersion}
            root={root}
            dir=""
            depth={0}
            changes={changes}
            expanded={expanded}
            onToggle={toggleDir}
            onOpen={setOpenPath}
          />
        </div>
      )}
    </div>
  );
}

function TreeLevel({
  root,
  dir,
  depth,
  changes,
  expanded,
  onToggle,
  onOpen,
}: {
  root: string;
  dir: string;
  depth: number;
  changes: Map<string, GitStatus>;
  expanded: ReadonlySet<string>;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    explorerList(root, dir)
      .then((list) => live && setEntries(list))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [root, dir]);

  const indent = { paddingLeft: 8 + depth * 12 };
  if (error) return <div className="explorer-note" style={indent}>{error}</div>;
  if (!entries) return depth === 0 ? <div className="explorer-note">Loading…</div> : null;
  if (entries.length === 0 && depth === 0) return <div className="explorer-note">Empty folder</div>;

  return (
    <>
      {entries.map((e) => {
        const open = e.isDir && expanded.has(e.path);
        const status = e.isDir ? folderStatus(changes, e.path) : changes.get(e.path);
        return (
          <div key={e.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-expanded={e.isDir ? open : undefined}
              className="explorer-row"
              data-git={status}
              data-ignored={e.ignored || undefined}
              style={indent}
              title={status ? `${e.path} • ${STATUS_LABEL[status]}` : e.ignored ? `${e.path} • Ignored` : e.path}
              onClick={() => (e.isDir ? onToggle(e.path) : onOpen(e.path))}
            >
              <span className={`codicon codicon-${e.isDir ? (open ? "chevron-down" : "chevron-right") : "blank"}`} aria-hidden />
              <span className={`codicon codicon-${e.isDir ? "folder" : isMarkdown(e.name) ? "markdown" : "file"} explorer-icon`} aria-hidden />
              <span className="explorer-name">{e.name}</span>
              {status && <span className="explorer-badge">{e.isDir ? "•" : status}</span>}
            </button>
            {open && (
              <TreeLevel
                root={root}
                dir={e.path}
                depth={depth + 1}
                changes={changes}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

type Mode = "preview" | "edit" | "changes";

function FileView({
  root,
  path,
  line,
  seq,
  status,
  onBack,
  onSaved,
  onDirty,
}: {
  root: string;
  path: string;
  line: number | null;
  seq: number;
  status: GitStatus | undefined;
  onBack: () => void;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("preview");
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = saved !== null && draft !== saved;
  const name = path.split("/").pop() ?? path;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  // A link to a line shows the source, where the line can be found.
  useEffect(() => {
    if (line !== null && !dirty) setMode("preview");
    // Only when a new reveal arrives.
  }, [seq]);

  useEffect(() => {
    let live = true;
    explorerRead(root, path)
      .then((text) => {
        if (!live) return;
        setSaved(text);
        setDraft(text);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [root, path]);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await explorerWrite(root, path, draft);
      setSaved(draft);
      setError(null);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const back = async () => {
    if (dirty && !(await ask(`Discard unsaved changes to ${name}?`, { title: "Unsaved Changes", kind: "warning" }))) return;
    onBack();
  };

  const canDiff = status !== undefined && status !== "D";

  return (
    <div className="explorer-file">
      <div className="explorer-file-header">
        <button type="button" className="icon-button" aria-label="Back to Files" title="Back to Files" onClick={() => void back()}>
          <span className="codicon codicon-arrow-left" aria-hidden />
        </button>
        <span className="explorer-file-name" title={path} data-git={status}>
          {name}
          {dirty && <span className="explorer-dirty" aria-label="Unsaved"> ●</span>}
        </span>
        <span className="explorer-modes" role="tablist">
          <ModeTab mode="preview" current={mode} onSelect={setMode} icon="eye" label="Preview" />
          <ModeTab mode="edit" current={mode} onSelect={setMode} icon="edit" label="Edit" />
          {canDiff && <ModeTab mode="changes" current={mode} onSelect={setMode} icon="git-compare" label="Changes vs HEAD" />}
        </span>
        <button
          type="button"
          className="vscode-button explorer-save"
          disabled={!dirty || saving}
          title="Save (⌘S)"
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {error && <div className="explorer-error">{error}</div>}
      {saved === null ? (
        !error && <div className="explorer-note">Loading…</div>
      ) : mode === "edit" ? (
        <textarea
          className="explorer-editor"
          value={draft}
          spellCheck={isMarkdown(path)}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "s" && e.metaKey) {
              e.preventDefault();
              void save();
            }
          }}
        />
      ) : mode === "changes" ? (
        <ChangesView root={root} path={path} version={saved} />
      ) : isMarkdown(path) && line === null ? (
        <div className="explorer-preview">
          <Markdown text={draft} />
        </div>
      ) : (
        <CodePreview text={draft} lang={extOf(path)} line={line} seq={seq} />
      )}
    </div>
  );
}

function ModeTab({
  mode,
  current,
  onSelect,
  icon,
  label,
}: {
  mode: Mode;
  current: Mode;
  onSelect: (m: Mode) => void;
  icon: string;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      className="icon-button"
      aria-selected={mode === current}
      aria-pressed={mode === current}
      aria-label={label}
      title={label}
      onClick={() => onSelect(mode)}
    >
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}

/** The saved file against HEAD; `version` re-fetches after a save. */
function ChangesView({ root, path, version }: { root: string; path: string; version: string }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    explorerGitDiff(root, path)
      .then((d) => live && setDiff(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [root, path, version]);
  if (error) return <div className="explorer-error">{error}</div>;
  if (!diff) return <div className="explorer-note">Loading…</div>;
  return (
    <div className="explorer-changes">
      <DiffView diffs={[diff]} />
    </div>
  );
}

function CodePreview({ text, lang, line, seq }: { text: string; lang: string | undefined; line: number | null; seq: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setHtml(null);
    if (text.length > MAX_HIGHLIGHT_CHARS) return;
    let live = true;
    void highlight(text, lang).then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [text, lang]);

  // Scroll the target line into view and mark it, in either rendering (both emit `.line` spans).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || line === null) return;
    el.querySelector(".explorer-line-target")?.classList.remove("explorer-line-target");
    const lines = el.querySelectorAll(".line");
    const target = lines[Math.min(line, lines.length) - 1];
    if (!target) return;
    target.classList.add("explorer-line-target");
    target.scrollIntoView?.({ block: "center" });
  }, [html, line, seq]);

  if (html) {
    // Shiki escapes the source text; same trust model as Markdown code blocks.
    return <div ref={ref as RefObject<HTMLDivElement>} className="explorer-code" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre ref={ref as RefObject<HTMLPreElement>} className="explorer-code">
      {line === null
        ? text
        : text.split("\n").map((l, i) => [
            i > 0 && "\n",
            <span key={i} className="line">
              {l}
            </span>,
          ])}
    </pre>
  );
}

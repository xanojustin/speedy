// Picks a folder on a host (R14): the native picker only sees This Mac's disk, so a remote
// host's folders come from its agent's directory listing. Starts in the host's home folder.
import { useEffect, useRef, useState } from "react";
import { hostCall, homeDir } from "../ipc/commands";
import type { DirEntry } from "../ipc/types";
import { hostLabel } from "../store/appStore";
import "./hosts.css";

interface Props {
  host: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

const parentOf = (path: string) => path.replace(/\/[^/]+\/?$/, "") || "/";
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

export function FolderBrowser({ host, onPick, onClose }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    void homeDir(host)
      .then((home) => setPath(home ?? "/"))
      .catch(() => setPath("/"));
  }, [host]);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setTyped(path);
    setEntries(null);
    setError(null);
    // Listed from the root, so any absolute path works.
    void hostCall<DirEntry[]>(host, "explorer_list", { root: "/", dir: path.replace(/^\/+/, "") })
      .then((all) => !cancelled && setEntries(all.filter((e) => e.isDir)))
      .catch((err: unknown) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [host, path]);

  const go = (next: string) => setPath(next.replace(/\/+$/, "") || "/");

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="settings-dialog folder-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-browser-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="settings-header">
          <h2 id="folder-browser-title" className="settings-title">
            Add Project on {hostLabel(host)}
          </h2>
          <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
            <span className="codicon codicon-close" aria-hidden />
          </button>
        </header>
        <form
          className="folder-browser-path"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.startsWith("/")) go(typed);
          }}
        >
          <button type="button" className="icon-button" aria-label="Up one folder" title="Up one folder" disabled={!path || path === "/"} onClick={() => path && go(parentOf(path))}>
            <span className="codicon codicon-arrow-up" aria-hidden />
          </button>
          <input className="vscode-input" aria-label="Folder path" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoFocus />
        </form>
        <div className="folder-browser-list" aria-busy={entries === null && !error}>
          {error && (
            <p className="folder-browser-message" role="alert">
              {error}
            </p>
          )}
          {!error && entries === null && <p className="folder-browser-message">Loading…</p>}
          {entries && entries.length === 0 && <p className="folder-browser-message">No folders here.</p>}
          {entries && entries.length > 0 && (
            <ul ref={listRef} aria-label="Folders">
              {entries.map((entry, i) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="folder-browser-row"
                    onClick={() => path && go(join(path, entry.name))}
                    onKeyDown={(e) => {
                      const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
                      if (e.key === "ArrowDown") rows?.[Math.min(i + 1, rows.length - 1)]?.focus();
                      else if (e.key === "ArrowUp") rows?.[Math.max(i - 1, 0)]?.focus();
                      else return;
                      e.preventDefault();
                    }}
                  >
                    <span className="codicon codicon-folder" aria-hidden />
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="folder-browser-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={!path || !!error} onClick={() => path && onPick(path)}>
            Add {path ? path.split("/").pop() || "/" : "folder"}
          </button>
        </footer>
      </div>
    </div>
  );
}

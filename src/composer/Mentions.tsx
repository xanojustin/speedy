// @-mention file search: debounced `files_search` (Rust, gitignore-aware, fuzzy-ranked) and its menu.
import { useEffect, useState } from "react";
import { filesSearch } from "../ipc/commands";
import type { FileHit } from "../ipc/types";

const MENTION_LIMIT = 50;
const DEBOUNCE_MS = 100;

/** Hits for `query` (null = no mention being typed). Stale responses are dropped. */
export function useFileMentions(root: string | null, query: string | null, respectGitIgnore: boolean): FileHit[] {
  const [hits, setHits] = useState<FileHit[]>([]);
  useEffect(() => {
    if (query === null || !root) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      filesSearch(root, query, MENTION_LIMIT, respectGitIgnore)
        .then((r) => {
          if (live) setHits(Array.isArray(r) ? r : []);
        })
        .catch(() => {
          if (live) setHits([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [root, query, respectGitIgnore]);
  return hits;
}

function split(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

export function MentionMenu({
  hits,
  activeIndex,
  onSelect,
  onHover,
}: {
  hits: FileHit[];
  activeIndex: number;
  onSelect(hit: FileHit): void;
  onHover(index: number): void;
}) {
  return (
    <div className="composer-popup" role="listbox" aria-label="Files">
      {hits.length === 0 ? (
        <div className="composer-popup-empty">No matching files</div>
      ) : (
        <div className="composer-popup-list">
          {hits.map((h, i) => {
            const { name, dir } = split(h.path);
            return (
              <div
                key={h.path}
                role="option"
                aria-selected={i === activeIndex}
                className={`composer-popup-item file${i === activeIndex ? " active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onHover(i)}
                onClick={() => onSelect(h)}
                title={h.path}
              >
                <i className={`codicon codicon-${h.isDir ? "folder" : "file"} file-icon`} aria-hidden="true" />
                <span className="file-name">{name}</span>
                <span className="file-dir">{dir}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

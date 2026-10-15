// Projects and their threads, with a live status glyph per thread (R2, R3, R5).
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { addProjectViaPicker, closeThread, newThread, removeProject } from "../app/actions";
import { pathsExist } from "../ipc/commands";
import type { Project } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { beginDragReorder } from "./dragReorder";
import { ProjectRow } from "./ProjectRow";
import "./sidebar.css";

interface SidebarProps {
  /** Threads that finished while not visible (filled in by the attention unit, U12). */
  unread?: ReadonlySet<string>;
}

export function Sidebar({ unread }: SidebarProps) {
  const projects = useAppStore((s) => s.projects);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const moveProject = useAppStore((s) => s.moveProject);
  const missing = useMissingProjects(projects);

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onProjectMenu = (e: MouseEvent, project: Project) =>
    openMenu(e, [
      { label: "New Thread", onSelect: () => newThread(project.id) },
      { label: "Show Past Conversations", onSelect: () => setHistoryFor(project.id) },
      "separator",
      { label: "Remove Project", onSelect: () => void removeProject(project.id) },
    ]);

  const onThreadMenu = (e: MouseEvent, threadId: string) =>
    openMenu(e, [
      { label: "Rename", onSelect: () => setRenamingId(threadId) },
      { label: "Archive", onSelect: () => void closeThread(threadId) },
    ]);

  const onProjectPointerDown = (e: PointerEvent, projectId: string) =>
    beginDragReorder({
      id: projectId,
      event: e,
      items: () => [...(treeRef.current?.querySelectorAll<HTMLElement>(":scope > .project") ?? [])],
      onDrop: moveProject,
    });

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar-title">
        <h2 className="sidebar-title-label">Projects</h2>
        <span className="sidebar-title-actions">
          <button type="button" className="icon-button" aria-label="Add Project Folder…" title="Add Project Folder… (⌘O)" onClick={() => void addProjectViaPicker()}>
            <span className="codicon codicon-new-folder" aria-hidden />
          </button>
        </span>
      </div>
      <div ref={treeRef} className="sidebar-tree" role="tree" aria-label="Projects and threads">
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            selectedThreadId={selectedThreadId}
            missing={missing.has(p.id)}
            unread={unread}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            historyOpen={historyFor === p.id}
            setHistoryOpen={(open) => setHistoryFor(open ? p.id : null)}
            onProjectMenu={onProjectMenu}
            onThreadMenu={onThreadMenu}
            onProjectPointerDown={onProjectPointerDown}
            onNewThread={newThread}
          />
        ))}
      </div>
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </nav>
  );
}

/** Ids of projects whose folder no longer exists. Re-checked when the project paths change. */
function useMissingProjects(projects: Project[]) {
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const key = projects.map((p) => `${p.id}\0${p.path}`).join("\n");
  useEffect(() => {
    if (!projects.length) {
      setMissing(new Set());
      return;
    }
    let cancelled = false;
    pathsExist(projects.map((p) => p.path))
      .then((exists) => {
        if (!cancelled) setMissing(new Set(projects.filter((_, i) => exists[i] === false).map((p) => p.id)));
      })
      .catch((err) => console.warn("paths_exist failed", err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the paths
  }, [key]);
  return missing;
}

import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { SessionList } from "../history/SessionList";
import type { Project } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { beginDragReorder } from "./dragReorder";
import { SectionHeader } from "./SectionHeader";
import { ThreadRow } from "./ThreadRow";

interface Props {
  project: Project;
  selectedThreadId: string | null;
  missing: boolean;
  unread?: ReadonlySet<string>;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  /** Archived threads are listed only on request (the project's context menu). */
  archivedOpen: boolean;
  setArchivedOpen: (open: boolean) => void;
  onProjectMenu: (e: MouseEvent, project: Project) => void;
  onThreadMenu: (e: MouseEvent, threadId: string) => void;
  onProjectPointerDown: (e: PointerEvent, projectId: string) => void;
  onNewThread: (projectId: string) => void;
}

/** The sidebar title of the built-in project for threads that don't belong to a folder. */
export const CHATS_LABEL = "No Project";

export function ProjectRow(props: Props) {
  const { project, selectedThreadId, missing, unread, renamingId, setRenamingId, historyOpen, setHistoryOpen, archivedOpen, setArchivedOpen } = props;
  const setProjectCollapsed = useAppStore((s) => s.setProjectCollapsed);
  const restoreThread = useAppStore((s) => s.restoreThread);
  const moveThread = useAppStore((s) => s.moveThread);
  const listRef = useRef<HTMLDivElement>(null);

  const live = project.threads.filter((t) => !t.archived);
  const archived = project.threads.filter((t) => t.archived);
  // Chats has no header row to collapse it from.
  const expanded = project.scratch || !project.collapsed;

  const onThreadPointerDown = (e: PointerEvent, threadId: string) =>
    beginDragReorder({
      id: threadId,
      event: e,
      items: () => [...(listRef.current?.querySelectorAll<HTMLElement>(":scope > .thread-row") ?? [])],
      // Indexes count live threads; map back to the full list, which also holds archived ones.
      onDrop: (id, toIndex) => {
        const others = project.threads.filter((t) => !t.archived && t.id !== id);
        const anchor = others[toIndex];
        const all = project.threads.filter((t) => t.id !== id);
        moveThread(id, anchor ? all.indexOf(anchor) : all.length);
      },
    });

  const actions = (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label="Show Past Conversations"
        title="Show Past Conversations"
        aria-pressed={historyOpen}
        onClick={(e) => {
          e.stopPropagation();
          setHistoryOpen(!historyOpen);
        }}
      >
        <span className="codicon codicon-history" aria-hidden />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="New Thread"
        title="New Thread"
        onClick={(e) => {
          e.stopPropagation();
          props.onNewThread(project.id);
        }}
      >
        <span className="codicon codicon-add" aria-hidden />
      </button>
    </>
  );

  return (
    <div className="project" data-project-id={project.id} data-drag-id={project.id} role="group" aria-label={project.scratch ? CHATS_LABEL : project.name}>
      {project.scratch ? (
        // Chats is a sidebar section of its own, titled like the Projects section below it.
        <SectionHeader
          icon="comment-discussion"
          label={CHATS_LABEL}
          title="Threads that don't belong to a project"
          onContextMenu={(e) => props.onProjectMenu(e, project)}
        >
          {actions}
        </SectionHeader>
      ) : (
        <div
          role="treeitem"
          aria-level={1}
          aria-expanded={expanded}
          tabIndex={-1}
          className="project-header sidebar-row"
          title={missing ? `${project.path} (folder not found)` : project.path}
          onClick={() => setProjectCollapsed(project.id, expanded)}
          onContextMenu={(e) => props.onProjectMenu(e, project)}
          onPointerDown={(e) => props.onProjectPointerDown(e, project.id)}
        >
          <span className={`codicon codicon-chevron-${expanded ? "down" : "right"} twistie`} aria-hidden />
          <span className="project-name">{project.name}</span>
          {missing && (
            <span className="project-missing">
              <span className="codicon codicon-warning" aria-hidden />
              missing
            </span>
          )}
          <span className="row-actions">{actions}</span>
        </div>
      )}

      {historyOpen && <HistoryPopover project={project} onClose={() => setHistoryOpen(false)} />}

      {expanded && (
        <>
          <div ref={listRef} className="thread-list" role="group">
            {live.length === 0 && (
              <button type="button" className="thread-empty sidebar-row" title="Start a new thread" onClick={() => props.onNewThread(project.id)}>
                {project.scratch ? "Ask anything, no folder needed" : "No threads"}
              </button>
            )}
            {live.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                selected={t.id === selectedThreadId}
                unread={unread?.has(t.id) ?? false}
                renaming={renamingId === t.id}
                onStartRename={() => setRenamingId(t.id)}
                onRenameDone={() => setRenamingId(null)}
                onContextMenu={(e) => props.onThreadMenu(e, t.id)}
                onPointerDown={(e) => onThreadPointerDown(e, t.id)}
              />
            ))}
          </div>
          {archivedOpen && archived.length > 0 && (
            <div className="archived-section">
              <button
                type="button"
                className="archived-toggle sidebar-row"
                aria-expanded
                title="Hide archived threads"
                onClick={() => setArchivedOpen(false)}
              >
                <span className="codicon codicon-chevron-down twistie" aria-hidden />
                <span>Archived ({archived.length})</span>
              </button>
              {archived.map((t) => (
                  <div key={t.id} className="archived-row sidebar-row" data-thread-id={t.id}>
                    <span className="codicon codicon-archive" aria-hidden />
                    <span className="thread-title" title={t.title}>
                      {t.title}
                    </span>
                    <span className="row-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Restore ${t.title}`}
                        title="Restore"
                        onClick={() => restoreThread(t.id)}
                      >
                        <span className="codicon codicon-discard" aria-hidden />
                      </button>
                    </span>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HistoryPopover({ project, onClose }: { project: Project; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: globalThis.PointerEvent) => {
      const target = e.target as HTMLElement;
      // The history button toggles the popover itself.
      if (!ref.current?.contains(target) && !target.closest?.(`[data-project-id="${project.id}"] :is(.project-header, .sidebar-title)`)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose, project.id]);

  return (
    <div ref={ref} role="dialog" aria-label={`Past conversations in ${project.scratch ? CHATS_LABEL : project.name}`} className="history-popover">
      <SessionList projectId={project.id} onClose={onClose} />
    </div>
  );
}

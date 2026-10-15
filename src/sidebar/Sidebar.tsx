// Projects and their threads, with a live status glyph per thread (R2, R3, R5).
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { addProjectViaPicker, closeThread, newThread, removeProject } from "../app/actions";
import { pathsExist } from "../ipc/commands";
import { GROUP_COLORS, type Group, type Project } from "../ipc/types";
import { sidebarSections, useAppStore } from "../store/appStore";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { beginDragReorder } from "./dragReorder";
import { GroupSection, groupColorVar } from "./GroupSection";
import { ProjectRow } from "./ProjectRow";
import "./sidebar.css";

interface SidebarProps {
  /** Threads that finished while not visible. */
  unread?: ReadonlySet<string>;
}

export function Sidebar({ unread }: SidebarProps) {
  const projects = useAppStore((s) => s.projects);
  const groups = useAppStore((s) => s.groups);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const moveProject = useAppStore((s) => s.moveProject);
  const moveGroup = useAppStore((s) => s.moveGroup);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const missing = useMissingProjects(projects);

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [archivedFor, setArchivedFor] = useState<ReadonlySet<string>>(new Set());
  const setArchivedOpen = (projectId: string, open: boolean) =>
    setArchivedFor((prev) => {
      const next = new Set(prev);
      if (open) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  const treeRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  /** Creates a group and puts its name in edit mode, optionally filing a project under it. */
  const startNewGroup = (projectId?: string) => {
    const store = useAppStore.getState();
    const groupId = store.createGroup("New Group");
    if (projectId) store.setProjectGroup(projectId, groupId);
    setRenamingId(groupId);
  };

  const onProjectMenu = (e: MouseEvent, project: Project) => {
    const { setProjectGroup } = useAppStore.getState();
    const grouped = groups.some((g) => g.id === project.groupId);
    const archivedCount = project.threads.filter((t) => t.archived).length;
    const archivedShown = archivedFor.has(project.id);
    openMenu(e, [
      { label: "New Thread", onSelect: () => newThread(project.id) },
      { label: "Show Past Conversations", onSelect: () => setHistoryFor(project.id) },
      ...(archivedCount
        ? [
            {
              label: archivedShown ? "Hide Archived" : `Show Archived (${archivedCount})`,
              onSelect: () => setArchivedOpen(project.id, !archivedShown),
            },
          ]
        : []),
      "separator",
      ...groups
        .filter((g) => g.id !== project.groupId)
        .map((g): MenuItem => ({ label: `Move to ${g.name}`, onSelect: () => setProjectGroup(project.id, g.id) })),
      { label: "Move to New Group…", onSelect: () => startNewGroup(project.id) },
      ...(grouped ? [{ label: "Remove from Group", onSelect: () => setProjectGroup(project.id, null) }] : []),
      "separator",
      { label: "Remove Project", onSelect: () => void removeProject(project.id) },
    ]);
  };

  const onGroupMenu = (e: MouseEvent, group: Group) => {
    const { x, y } = { x: e.clientX, y: e.clientY };
    const colorMenu: MenuItem[] = GROUP_COLORS.map((color) => ({
      label: color[0].toUpperCase() + color.slice(1),
      swatch: groupColorVar({ color }),
      checked: group.color === color,
      onSelect: () => useAppStore.getState().setGroupColor(group.id, color),
    }));
    openMenu(e, [
      { label: "Rename", onSelect: () => setRenamingId(group.id) },
      // The menu closes before onSelect runs; reopen it in place with the palette.
      { label: "Change Color…", onSelect: () => setTimeout(() => setMenu({ x, y, items: colorMenu })) },
      "separator",
      { label: "Delete Group", onSelect: () => useAppStore.getState().deleteGroup(group.id) },
    ]);
  };

  const onThreadMenu = (e: MouseEvent, threadId: string) =>
    openMenu(e, [
      { label: "Rename", onSelect: () => setRenamingId(threadId) },
      { label: "Archive", onSelect: () => void closeThread(threadId) },
    ]);

  // Projects reorder within their own section; moving between groups is a context-menu action.
  const onProjectPointerDown = (e: PointerEvent, projectId: string) => {
    const list = (e.currentTarget as HTMLElement).closest(".project")?.parentElement;
    beginDragReorder({
      id: projectId,
      event: e,
      items: () => [...(list?.querySelectorAll<HTMLElement>(":scope > .project") ?? [])],
      // Indexes count the section's projects; map back to the full list, which holds every section.
      onDrop: (id, toIndex) => {
        const state = useAppStore.getState();
        const section = sidebarSections(state).find((sec) => sec.projects.some((p) => p.id === id));
        const others = section?.projects.filter((p) => p.id !== id) ?? [];
        const rest = state.projects.filter((p) => p.id !== id);
        const anchor = others[toIndex];
        const last = others.at(-1);
        moveProject(id, anchor ? rest.indexOf(anchor) : last ? rest.indexOf(last) + 1 : rest.length);
      },
    });
  };

  const onGroupPointerDown = (e: PointerEvent, groupId: string) =>
    beginDragReorder({
      id: groupId,
      event: e,
      items: () => [...(treeRef.current?.querySelectorAll<HTMLElement>(":scope > .group") ?? [])],
      onDrop: moveGroup,
    });

  const renderProject = (p: Project) => (
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
      archivedOpen={archivedFor.has(p.id)}
      setArchivedOpen={(open) => setArchivedOpen(p.id, open)}
      onProjectMenu={onProjectMenu}
      onThreadMenu={onThreadMenu}
      onProjectPointerDown={onProjectPointerDown}
      onNewThread={newThread}
    />
  );

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar-title">
        <h2 className="sidebar-title-label">Projects</h2>
        <span className="sidebar-title-actions">
          <button type="button" className="icon-button" aria-label="Add Project Folder…" title="Add Project Folder… (⌘O)" onClick={() => void addProjectViaPicker()}>
            <span className="codicon codicon-new-folder" aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="New Group" title="New Group" onClick={() => startNewGroup()}>
            <span className="codicon codicon-new-collection" aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Settings" title="Settings (⌘,)" onClick={() => setSettingsOpen(true)}>
            <span className="codicon codicon-settings-gear" aria-hidden />
          </button>
        </span>
      </div>
      <div ref={treeRef} className="sidebar-tree" role="tree" aria-label="Projects and threads">
        {sidebarSections({ projects, groups }).map(({ group, projects: members }) =>
          group ? (
            <GroupSection
              key={group.id}
              group={group}
              empty={members.length === 0}
              renaming={renamingId === group.id}
              onStartRename={() => setRenamingId(group.id)}
              onRenameDone={() => setRenamingId(null)}
              onContextMenu={(e) => onGroupMenu(e, group)}
              onPointerDown={(e) => onGroupPointerDown(e, group.id)}
            >
              {members.map(renderProject)}
            </GroupSection>
          ) : (
            members.map(renderProject)
          ),
        )}
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

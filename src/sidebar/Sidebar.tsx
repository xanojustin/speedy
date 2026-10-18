// Projects and their threads, with a live status glyph per thread (R2, R3, R5).
import { useCallback, useEffect, useState, type MouseEvent, type PointerEvent } from "react";
import { addProjectViaPicker, cleanUpWorktrees, closeThread, newThread, removeProject } from "../app/actions";
import { FolderBrowser } from "../hosts/FolderBrowser";
import { HostHeader } from "../hosts/HostHeader";
import { openInVscode, pathsExist } from "../ipc/commands";
import { GROUP_COLORS, LOCAL_HOST, type Group, type HostInfo, type Project } from "../ipc/types";
import { hostLabel, hostSections, sidebarSections, useAppStore, type SidebarSection } from "../store/appStore";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { beginDragReorder } from "./dragReorder";
import { GroupSection, groupColorVar } from "./GroupSection";
import { CHATS_LABEL, ProjectRow } from "./ProjectRow";
import { SectionHeader } from "./SectionHeader";
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
  const hosts = useAppStore((s) => s.hosts);
  const missing = useMissingProjects(projects, hosts);
  /** The SSH host whose folder browser is open. */
  const [browseHost, setBrowseHost] = useState<string | null>(null);

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
  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  /** Creates a group and puts its name in edit mode, optionally filing a project under it. */
  const startNewGroup = (projectId?: string, hostKey = LOCAL_HOST) => {
    const store = useAppStore.getState();
    const groupId = store.createGroup("New Group", hostKey);
    if (projectId) store.setProjectGroup(projectId, groupId);
    setRenamingId(groupId);
  };

  const onProjectMenu = (e: MouseEvent, project: Project) => {
    const { setProjectGroup } = useAppStore.getState();
    const grouped = groups.some((g) => g.id === project.groupId);
    const hostGroups = groups.filter((g) => (g.hostKey ?? LOCAL_HOST) === project.hostKey);
    const archivedCount = project.threads.filter((t) => t.archived).length;
    const archivedShown = archivedFor.has(project.id);
    const threadItems: MenuItem[] = [
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
    ];
    // Chats has no folder of its own to open, group, or remove.
    if (project.scratch) return openMenu(e, threadItems);
    openMenu(e, [
      ...threadItems,
      "separator",
      {
        label: "Open in VS Code",
        onSelect: () => void openInVscode(project.path, project.hostKey).catch((err) => console.warn("open_in_vscode failed", err)),
      },
      ...(project.threads.some((t) => t.worktree) ? [{ label: "Clean Up Worktrees…", onSelect: () => void cleanUpWorktrees(project.id) }] : []),
      "separator",
      {
        label: "Move to Group",
        submenu: [
          ...hostGroups.map((g): MenuItem => ({
            label: g.name,
            swatch: groupColorVar(g),
            checked: g.id === project.groupId,
            onSelect: () => setProjectGroup(project.id, g.id),
          })),
          ...(hostGroups.length ? ["separator" as const] : []),
          { label: "New Group…", onSelect: () => startNewGroup(project.id, project.hostKey) },
          ...(grouped ? [{ label: "Remove from Group", onSelect: () => setProjectGroup(project.id, null) }] : []),
        ],
      },
      "separator",
      { label: "Remove Project", onSelect: () => void removeProject(project.id) },
    ]);
  };

  const onGroupMenu = (e: MouseEvent, group: Group) =>
    openMenu(e, [
      { label: "Rename", onSelect: () => setRenamingId(group.id) },
      {
        label: "Color",
        submenu: GROUP_COLORS.map((color) => ({
          label: color[0].toUpperCase() + color.slice(1),
          swatch: groupColorVar({ color }),
          checked: group.color === color,
          onSelect: () => useAppStore.getState().setGroupColor(group.id, color),
        })),
      },
      "separator",
      { label: "Delete Group", onSelect: () => useAppStore.getState().deleteGroup(group.id) },
    ]);

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

  const onGroupPointerDown = (e: PointerEvent, groupId: string) => {
    // Groups reorder within their host's tree.
    const tree = (e.currentTarget as HTMLElement).closest(".sidebar-tree");
    beginDragReorder({
      id: groupId,
      event: e,
      items: () => [...(tree?.querySelectorAll<HTMLElement>(":scope > .group") ?? [])],
      onDrop: moveGroup,
    });
  };

  /** This Mac picks with the native dialog; another host's folders come from its agent (R14). */
  const addProjectOn = (hostKey: string) => (hostKey === LOCAL_HOST ? void addProjectViaPicker() : setBrowseHost(hostKey));

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

  const renderTree = (folderSections: SidebarSection[], label: string) => (
    <div className="sidebar-tree" role="tree" aria-label={label}>
      {folderSections.map(({ group, projects: members }) =>
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
  );

  const renderChats = (chats: Project[], label: string) =>
    chats.length > 0 && (
      <div className="sidebar-chats" role="tree" aria-label={label}>
        {chats.map(renderProject)}
      </div>
    );

  const settingsButton = (
    <button type="button" className="icon-button" aria-label="Settings" title="Settings (⌘,)" onClick={() => setSettingsOpen(true)}>
      <span className="codicon codicon-settings-gear" aria-hidden />
    </button>
  );

  // One host: a single Projects list. Several: a section per host, This Mac first (R13).
  let body;
  if (hosts.length <= 1) {
    const [{ projects: chats }, ...folderSections] = sidebarSections({ projects, groups });
    body = (
      <>
        {renderChats(chats, CHATS_LABEL)}
        <SectionHeader icon="folder-library" label="Projects">
          <button type="button" className="icon-button" aria-label="Add Project Folder…" title="Add Project Folder… (⌘O)" onClick={() => void addProjectViaPicker()}>
            <span className="codicon codicon-new-folder" aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="New Group" title="New Group" onClick={() => startNewGroup()}>
            <span className="codicon codicon-new-collection" aria-hidden />
          </button>
          {settingsButton}
        </SectionHeader>
        {renderTree(folderSections, "Projects and threads")}
      </>
    );
  } else {
    body = (
      <>
        <SectionHeader icon="remote-explorer" label="Hosts">
          {settingsButton}
        </SectionHeader>
        {hostSections({ projects, groups, hosts }).map(({ host, sections: [{ projects: chats }, ...folderSections] }) => (
          <section key={host.key} className="sidebar-host" aria-label={hostLabel(host.key)}>
            <HostHeader host={host} onAddProject={() => addProjectOn(host.key)} onNewGroup={() => startNewGroup(undefined, host.key)} openMenu={openMenu} />
            {renderChats(chats, `${CHATS_LABEL} on ${hostLabel(host.key)}`)}
            {renderTree(folderSections, `Projects and threads on ${hostLabel(host.key)}`)}
          </section>
        ))}
      </>
    );
  }

  return (
    <nav className="sidebar" aria-label="Projects">
      {body}
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
      {browseHost && (
        <FolderBrowser
          host={browseHost}
          onClose={() => setBrowseHost(null)}
          onPick={(path) => {
            useAppStore.getState().addProject(path, browseHost);
            setBrowseHost(null);
          }}
        />
      )}
    </nav>
  );
}

/**
 * Ids of projects whose folder no longer exists, asked of each project's own host (a host
 * that isn't connected can't say, so its projects aren't flagged). Re-checked when the
 * project paths or host connections change.
 */
function useMissingProjects(projects: Project[], hosts: HostInfo[]) {
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const connected = hosts.filter((h) => h.state.state === "connected").map((h) => h.key);
  const key = `${projects.map((p) => `${p.hostKey}\0${p.id}\0${p.path}`).join("\n")}|${connected.join(",")}`;
  useEffect(() => {
    let cancelled = false;
    const byHost = new Map<string, Project[]>();
    for (const p of projects) if (connected.includes(p.hostKey)) byHost.set(p.hostKey, [...(byHost.get(p.hostKey) ?? []), p]);
    if (!byHost.size) {
      setMissing(new Set());
      return;
    }
    void Promise.all(
      [...byHost].map(async ([host, list]) => {
        const exists = await pathsExist(list.map((p) => p.path), host).catch((err) => {
          console.warn("paths_exist failed", err);
          return list.map(() => true);
        });
        return list.filter((_, i) => exists[i] === false).map((p) => p.id);
      }),
    ).then((ids) => {
      if (!cancelled) setMissing(new Set(ids.flat()));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the paths and connections
  }, [key]);
  return missing;
}

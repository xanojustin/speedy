// A user-named sidebar section that projects can be filed under, like Slack's channel sections.
import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from "react";
import type { Group } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { RenameInput } from "./ThreadRow";

interface Props {
  group: Group;
  empty: boolean;
  renaming: boolean;
  onStartRename: () => void;
  onRenameDone: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  children: ReactNode;
}

export const groupColorVar = (group: Pick<Group, "color">) =>
  group.color ? `var(--vscode-charts-${group.color})` : "var(--vscode-descriptionForeground)";

export function GroupSection({ group, empty, renaming, onStartRename, onRenameDone, onContextMenu, onPointerDown, children }: Props) {
  const setGroupCollapsed = useAppStore((s) => s.setGroupCollapsed);
  const expanded = !group.collapsed;

  return (
    <div
      className="group"
      data-group-id={group.id}
      data-drag-id={group.id}
      role="group"
      aria-label={group.name}
      style={{ "--group-color": groupColorVar(group) } as CSSProperties}
    >
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        tabIndex={-1}
        className="group-header sidebar-row"
        onClick={() => !renaming && setGroupCollapsed(group.id, expanded)}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onKeyDown={(e) => {
          if (e.key === "F2" && !renaming) {
            e.preventDefault();
            onStartRename();
          }
        }}
      >
        <span className={`codicon codicon-chevron-${expanded ? "down" : "right"} twistie`} aria-hidden />
        {renaming ? (
          <RenameInput
            initial={group.name}
            label="Group name"
            onCommit={(name) => useAppStore.getState().renameGroup(group.id, name)}
            onDone={onRenameDone}
          />
        ) : (
          <span className="group-name" title={group.name} onDoubleClick={onStartRename}>
            {group.name}
          </span>
        )}
        <span className="group-dot" aria-hidden />
      </div>
      {expanded && (
        <div className="group-projects">
          {children}
          {empty && <div className="group-empty">Right-click a project to move it here</div>}
        </div>
      )}
    </div>
  );
}

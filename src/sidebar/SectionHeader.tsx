// The title bar of a top-level sidebar section (No Project, Projects): icon, uppercase label, actions on the right.
import type { MouseEvent, ReactNode } from "react";

interface Props {
  /** A codicon name, without the `codicon-` prefix. */
  icon: string;
  label: string;
  title?: string;
  onContextMenu?: (e: MouseEvent) => void;
  /** Icon buttons, shown right-aligned. */
  children?: ReactNode;
}

export function SectionHeader({ icon, label, title, onContextMenu, children }: Props) {
  return (
    <div className="sidebar-title" title={title} onContextMenu={onContextMenu}>
      <span className={`codicon codicon-${icon} sidebar-title-icon`} aria-hidden />
      <h2 className="sidebar-title-label">{label}</h2>
      {children && <span className="sidebar-title-actions">{children}</span>}
    </div>
  );
}

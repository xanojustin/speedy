// A host's section header in the sidebar (R3): a divider with its name, connection state in
// words, and actions. Clicking it collapses the host's section. A host that isn't connected
// keeps its header, so it's clear where its projects went.
import type { MouseEvent } from "react";
import { hostReconnect, localAgentStart } from "../ipc/commands";
import { LOCAL_HOST, type HostInfo } from "../ipc/types";
import { hostLabel, hostStateLabel, useAppStore } from "../store/appStore";
import type { MenuItem } from "../sidebar/ContextMenu";
import { stopLocalAgent } from "./localAgent";
import "./hosts.css";

interface Props {
  host: HostInfo;
  collapsed: boolean;
  onToggle: () => void;
  onAddProject: () => void;
  onNewGroup: () => void;
  openMenu: (e: MouseEvent, items: MenuItem[]) => void;
}

export function HostHeader({ host, collapsed, onToggle, onAddProject, onNewGroup, openMenu }: Props) {
  const connected = host.state.state === "connected";
  const local = host.key === LOCAL_HOST;
  const label = hostLabel(host.key);
  const reconnect = () => void hostReconnect(host.key).catch((err) => console.warn("reconnect failed", err));

  const items: MenuItem[] = [
    { label: "Add Project Folder…", onSelect: onAddProject },
    { label: "New Group", onSelect: onNewGroup },
    "separator",
    ...(local
      ? connected
        ? [{ label: "Stop This Mac's Agent…", onSelect: () => void stopLocalAgent() }]
        : [{ label: "Start This Mac's Agent", onSelect: () => void localAgentStart().catch((err) => console.warn("starting the agent failed", err)) }]
      : [
          { label: "Reconnect", onSelect: reconnect },
          { label: "Remove Host", onSelect: () => void useAppStore.getState().removeHost(host.key) },
        ]),
  ];

  // Connected shows as a dot (its words stay for screen readers and the tooltip).
  const title = host.state.state === "reconnecting" ? host.state.error : connected ? "Connected" : undefined;
  return (
    <div className="host-header" onContextMenu={(e) => openMenu(e, items)}>
      <button type="button" className="host-header-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`} onClick={onToggle}>
        <span className={`codicon codicon-chevron-${collapsed ? "right" : "down"} host-header-twistie`} aria-hidden />
        <span className={`codicon codicon-${local ? "device-desktop" : "server"} host-header-icon`} aria-hidden />
        <h2 className="host-header-name">{label}</h2>
      </button>
      <span className={`host-header-state ${host.state.state}`} title={title}>
        {hostStateLabel(host)}
      </span>
      {!connected && !local && (
        <button type="button" className="icon-button" aria-label={`Reconnect to ${label}`} title="Reconnect" onClick={reconnect}>
          <span className="codicon codicon-refresh" aria-hidden />
        </button>
      )}
      <button type="button" className="icon-button host-header-add" aria-label={`Add Project Folder on ${label}…`} title="Add Project Folder…" disabled={!connected} onClick={onAddProject}>
        <span className="codicon codicon-new-folder" aria-hidden />
      </button>
    </div>
  );
}

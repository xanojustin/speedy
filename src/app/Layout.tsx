// Sidebar + the selected thread's chat/terminal split (KTD2: only the selected thread is mounted).
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { findThread, useAppStore } from "../store/appStore";
import { Sidebar } from "../sidebar/Sidebar";
import { SettingsDialog } from "../settings/SettingsDialog";
import { Explorer } from "../explorer/Explorer";
import { onOpenFolders } from "../ipc/commands";
import { addDroppedPaths, addOpenedFolders, addProjectViaPicker } from "./actions";
import { useAttention } from "./attention";
import { useMenuShortcuts } from "./shortcuts";
import { ThreadView } from "./ThreadView";

const MIN_SIDEBAR = 170;
const MAX_SIDEBAR = 600;
const MIN_EXPLORER = 220;
const MAX_EXPLORER = 900;

export function Layout() {
  const projects = useAppStore((s) => s.projects);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selected = findThread({ projects }, selectedThreadId);
  const storedWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const explorerOpen = useAppStore((s) => s.explorerOpen);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dropActive = useFolderDrop();
  useOpenedFolders();
  useMenuShortcuts();
  const unread = useAttention();

  const width = dragWidth ?? storedWidth;

  const onSashPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const clamp = (w: number) => Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w));
    let latest = width;
    const onMove = (ev: PointerEvent) => {
      latest = clamp(width + ev.clientX - startX);
      setDragWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragWidth(null);
      setSidebarWidth(Math.round(latest));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={`layout${dropActive ? " drop-active" : ""}${dragWidth !== null ? " resizing-sidebar" : ""}`}>
      <div className="sidebar-container" style={{ width }}>
        <Sidebar unread={unread} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        className="sash sash-vertical"
        style={{ left: width - 2 }}
        onPointerDown={onSashPointerDown}
      />
      <main className="main-area">
        {selected ? <ThreadView key={selected.thread.id} project={selected.project} thread={selected.thread} /> : <EmptyState />}
      </main>
      {explorerOpen && selected && (
        <ExplorerPanel key={selected.project.path} root={selected.project.path} name={selected.project.name} onClose={() => setExplorerOpen(false)} />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** The explorer docked on the right, resizable from its left edge. */
function ExplorerPanel({ root, name, onClose }: { root: string; name: string; onClose: () => void }) {
  const storedWidth = useAppStore((s) => s.explorerWidth);
  const setExplorerWidth = useAppStore((s) => s.setExplorerWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? storedWidth;

  const onSashPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const clamp = (w: number) => Math.min(MAX_EXPLORER, Math.max(MIN_EXPLORER, w));
    let latest = width;
    const onMove = (ev: PointerEvent) => {
      latest = clamp(width - (ev.clientX - startX));
      setDragWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragWidth(null);
      setExplorerWidth(Math.round(latest));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <aside className={`explorer-container${dragWidth !== null ? " resizing-explorer" : ""}`} style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize explorer"
        aria-valuenow={width}
        className="sash sash-vertical"
        style={{ left: -2 }}
        onPointerDown={onSashPointerDown}
      />
      <Explorer root={root} name={name} onClose={onClose} />
    </aside>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <span className="codicon codicon-comment-discussion empty-state-icon" aria-hidden />
      <h1 className="empty-state-title">Speedy</h1>
      <p className="empty-state-text">Add a project folder to start a Claude Code thread with its own terminal.</p>
      <button type="button" className="vscode-button" onClick={() => void addProjectViaPicker()}>
        Add Project Folder
      </button>
      <dl className="empty-state-keys">
        <dt>Add Project Folder</dt>
        <dd>
          <kbd>⌘</kbd>
          <kbd>O</kbd>
        </dd>
        <dt>New Thread</dt>
        <dd>
          <kbd>⌘</kbd>
          <kbd>N</kbd>
        </dd>
        <dt>Toggle Terminal</dt>
        <dd>
          <kbd>⌘</kbd>
          <kbd>J</kbd>
        </dd>
        <dt>Toggle Explorer</dt>
        <dd>
          <kbd>⇧</kbd>
          <kbd>⌘</kbd>
          <kbd>E</kbd>
        </dd>
      </dl>
    </div>
  );
}

/** Folders opened with `speedy .` become projects, including ones queued before this mounted. */
function useOpenedFolders() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onOpenFolders(() => void addOpenedFolders()).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    void addOpenedFolders();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** Folders dropped onto the window become projects (R2). Returns whether a drag is hovering. */
function useFolderDrop() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") setActive(true);
        else {
          setActive(false);
          if (payload.type === "drop") void addDroppedPaths(payload.paths);
        }
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch((err) => console.warn("drag-drop listener unavailable", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return active;
}

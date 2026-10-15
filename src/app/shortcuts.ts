// App shortcuts (KTD10): native menu accelerators emit the `menu` event with an item id
// (src-tauri/src/menu.rs); this module dispatches them.
import { useEffect } from "react";
import { onMenu } from "../ipc/commands";
import type { MenuAction } from "../ipc/types";
import { findThread, useAppStore, visibleThreads } from "../store/appStore";
import { addProjectViaPicker, closeThread, newThread } from "./actions";

/** DOM event the composer (U9) listens for to take focus. */
export const FOCUS_COMPOSER_EVENT = "speedy:focus-composer";
export interface FocusComposerDetail {
  threadId: string;
}

export function toggleTerminal(threadId: string) {
  const t = findThread(useAppStore.getState(), threadId)?.thread;
  if (t) useAppStore.getState().updateThread(threadId, { terminalVisible: !t.terminalVisible });
}

export function toggleMaximizeTerminal(threadId: string) {
  const t = findThread(useAppStore.getState(), threadId)?.thread;
  if (!t) return;
  // Maximizing a hidden terminal shows it maximized.
  const maximize = !t.terminalVisible || !t.terminalMaximized;
  useAppStore.getState().updateThread(threadId, { terminalVisible: true, terminalMaximized: maximize });
}

export function focusChat(threadId: string) {
  const t = findThread(useAppStore.getState(), threadId)?.thread;
  if (t?.terminalMaximized) useAppStore.getState().updateThread(threadId, { terminalMaximized: false });
  window.dispatchEvent(new CustomEvent<FocusComposerDetail>(FOCUS_COMPOSER_EVENT, { detail: { threadId } }));
}

export function handleMenuAction(action: MenuAction) {
  const s = useAppStore.getState();
  const selected = s.selectedThreadId;
  switch (action) {
    case "new_thread":
      return newThread();
    case "add_project":
      return void addProjectViaPicker();
    case "close_thread":
      if (selected) void closeThread(selected);
      return;
    case "toggle_terminal":
      if (selected) toggleTerminal(selected);
      return;
    case "maximize_terminal":
      if (selected) toggleMaximizeTerminal(selected);
      return;
    case "focus_chat":
      if (selected) focusChat(selected);
      return;
    default: {
      const m = /^switch_thread_([1-9])$/.exec(action);
      const target = m && visibleThreads(s)[Number(m[1]) - 1];
      if (target) s.selectThread(target.id);
    }
  }
}

/** Subscribes to native menu events for the lifetime of the calling component. */
export function useMenuShortcuts() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onMenu(handleMenuAction).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

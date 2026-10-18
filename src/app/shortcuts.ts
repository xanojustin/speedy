// App shortcuts (KTD10): native menu accelerators emit the `menu` event with an item id
// (src-tauri/src/menu.rs); this module dispatches them.
import { useEffect } from "react";
import { stopLocalAgent } from "../hosts/localAgent";
import { onMenu } from "../ipc/commands";
import type { MenuAction } from "../ipc/types";
import { findThread, useAppStore, visibleThreads } from "../store/appStore";
import { ADD_TO_COMPOSER_EVENT, FOCUS_COMPOSER_EVENT, type AddToComposerDetail, type FocusComposerDetail } from "../composer/focusEvent";
import { addProjectViaPicker, closeThread, newThread } from "./actions";
import { disposeTerminal, focusTerminal } from "../terminal/registry";
import { terminalsOf, useTerminalTabs } from "../terminal/tabs";

/** Shows or hides the panel; hiding it hands focus back to the chat. */
export function toggleTerminal(threadId: string) {
  const t = findThread(useAppStore.getState(), threadId)?.thread;
  if (!t) return;
  useAppStore.getState().updateThread(threadId, { terminalVisible: !t.terminalVisible });
  if (t.terminalVisible) focusComposer(threadId);
}

export function toggleMaximizeTerminal(threadId: string) {
  const t = findThread(useAppStore.getState(), threadId)?.thread;
  if (!t) return;
  // Maximizing a hidden terminal shows it maximized.
  const maximize = !t.terminalVisible || !t.terminalMaximized;
  useAppStore.getState().updateThread(threadId, { terminalVisible: true, terminalMaximized: maximize });
}

/** Adds a terminal tab to the thread, shows the panel, and focuses the new shell. */
export function newTerminal(threadId: string) {
  const id = useTerminalTabs.getState().add(threadId);
  useAppStore.getState().updateThread(threadId, { terminalVisible: true });
  requestAnimationFrame(() => focusTerminal(id));
}

/**
 * Kills the terminal's shell and closes its tab, focusing the tab that takes its place. Killing the
 * last one hides the panel, like VS Code, and focuses the chat.
 */
export function killTerminal(threadId: string, terminalId: string) {
  const tabs = useTerminalTabs.getState();
  const last = tabs.remove(threadId, terminalId);
  disposeTerminal(terminalId);
  if (last) {
    useAppStore.getState().updateThread(threadId, { terminalVisible: false, terminalMaximized: false });
    focusComposer(threadId);
    return;
  }
  const { active } = terminalsOf(useTerminalTabs.getState().byThread, threadId);
  requestAnimationFrame(() => focusTerminal(active));
}

function focusComposer(threadId: string) {
  window.dispatchEvent(new CustomEvent<FocusComposerDetail>(FOCUS_COMPOSER_EVENT, { detail: { threadId } }));
}

function focusChat(threadId: string) {
  const t = findThread(useAppStore.getState(), threadId)?.thread;
  if (t?.terminalMaximized) useAppStore.getState().updateThread(threadId, { terminalMaximized: false });
  focusComposer(threadId);
}

/** Attaches terminal output to the thread's composer and moves focus there to write the message. */
export function addToChat(threadId: string, text: string, source: string) {
  if (!text.trim()) return;
  window.dispatchEvent(new CustomEvent<AddToComposerDetail>(ADD_TO_COMPOSER_EVENT, { detail: { threadId, text, source } }));
  focusChat(threadId);
}

function handleMenuAction(action: MenuAction) {
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
    case "new_terminal":
      if (selected) newTerminal(selected);
      return;
    case "toggle_explorer":
      return s.setExplorerOpen(!s.explorerOpen);
    case "focus_chat":
      if (selected) focusChat(selected);
      return;
    case "open_settings":
      return s.setSettingsOpen(true);
    case "stop_local_agent":
      return void stopLocalAgent();
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

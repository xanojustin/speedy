// U12: wires the sidebar to the Rust attention service (R5, R6). Reports the thread on screen
// (and marks it read), reports titles for notifications, follows notification clicks, and
// returns the finished-unread set for <Sidebar unread>. Also pushes the notification settings.
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { attentionMarkRead, attentionSetPrefs, attentionSetTitles, attentionSetVisible, onOpenThread, onUnread } from "../ipc/commands";
import { findThread, useAppStore } from "../store/appStore";

export function useAttention(): ReadonlySet<string> {
  const projects = useAppStore((s) => s.projects);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const visibleId = findThread({ projects }, selectedThreadId)?.thread.id ?? null;
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const notificationsEnabled = useAppStore((s) => s.notificationsEnabled);
  const completionSound = useAppStore((s) => s.completionSound);

  useEffect(() => {
    void attentionSetPrefs(notificationsEnabled, completionSound);
  }, [notificationsEnabled, completionSound]);

  useEffect(() => {
    void attentionSetVisible(visibleId);
    if (visibleId) void attentionMarkRead(visibleId);
  }, [visibleId]);

  const titlesKey = useMemo(
    () => JSON.stringify(Object.fromEntries(projects.flatMap((p) => p.threads.map((t) => [t.id, t.title])))),
    [projects],
  );
  useEffect(() => {
    void attentionSetTitles(JSON.parse(titlesKey) as Record<string, string>);
  }, [titlesKey]);

  useEffect(() => subscribe(onUnread((ids) => setUnread(new Set(ids)))), []);
  useEffect(() => subscribe(onOpenThread(openThread)), []);

  return unread;
}

/** Selects a thread from a notification click, expanding its project and group so the row is visible. */
function openThread(threadId: string) {
  const store = useAppStore.getState();
  const found = findThread(store, threadId);
  if (!found) return;
  if (found.project.collapsed) store.setProjectCollapsed(found.project.id, false);
  const group = store.groups.find((g) => g.id === found.project.groupId);
  if (group?.collapsed) store.setGroupCollapsed(group.id, false);
  store.selectThread(threadId);
}

function subscribe(listening: Promise<UnlistenFn>) {
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  listening
    .then((u) => {
      if (disposed) u();
      else unlisten = u;
    })
    .catch((err) => console.warn("attention listener unavailable", err));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

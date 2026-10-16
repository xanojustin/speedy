// App-level flows shared by the sidebar, the empty state, and the menu shortcuts.
import { ask, open } from "@tauri-apps/plugin-dialog";
import { claudeStop, openFoldersTake, pathsExist, ptyHasForegroundChild } from "../ipc/commands";
import { findThread, useAppStore } from "../store/appStore";
import { forgetStarted } from "../store/runtime";
import { getRuntime } from "../store/threadStore";
import { disposeThreadTerminals } from "../terminal/TerminalPane";
import { terminalsOf, useTerminalTabs } from "../terminal/tabs";

/** Opens the folder picker and adds the chosen folder (R2). */
export async function addProjectViaPicker(): Promise<void> {
  const picked = await open({ directory: true, multiple: false, title: "Add Project Folder" });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (path) useAppStore.getState().addProject(path);
}

/**
 * Adds folders dropped onto the window. Only directories become projects: `paths_exist`
 * is asked about each path with a trailing slash, which POSIX stat only resolves for a directory.
 */
export async function addDroppedPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const isDir = await pathsExist(paths.map((p) => p.replace(/\/+$/, "") + "/"));
  for (const [i, path] of paths.entries()) {
    if (isDir[i]) useAppStore.getState().addProject(path.replace(/\/+$/, "") || "/");
  }
}

/** Adds folders opened from outside the app (`speedy .`, Dock drops). Rust only queues directories. */
export async function addOpenedFolders(): Promise<void> {
  for (const path of await openFoldersTake()) useAppStore.getState().addProject(path);
}

/** New thread in the selected thread's project, else the first project, else pick a folder. */
export function newThread(projectId?: string): void {
  const s = useAppStore.getState();
  const target = projectId ?? findThread(s, s.selectedThreadId)?.project.id ?? s.projects[0]?.id;
  if (target) s.createThread(target);
  else void addProjectViaPicker();
}

/** True when the terminal's shell runs a foreground job (e.g. `npm run dev`). */
export async function terminalBusy(terminalId: string): Promise<boolean> {
  try {
    return await ptyHasForegroundChild(terminalId);
  } catch {
    return false; // no PTY opened for this terminal yet
  }
}

/** True when closing would kill live work: the agent is Working or any of its shells runs a foreground job. */
async function isBusy(threadId: string): Promise<boolean> {
  if (getRuntime(threadId).status === "working") return true;
  const { ids } = terminalsOf(useTerminalTabs.getState().byThread, threadId);
  return (await Promise.all(ids.map(terminalBusy))).some(Boolean);
}

/** Stops a thread's agent and shell. Sessions stay on disk. */
async function stopThread(threadId: string): Promise<void> {
  try {
    await claudeStop(threadId);
  } catch (err) {
    console.warn(`claude_stop(${threadId}) failed`, err);
  }
  // A restored thread must call claude_start again to leave Stopped.
  forgetStarted(threadId);
  try {
    disposeThreadTerminals(threadId);
  } catch (err) {
    console.warn(`disposeThreadTerminals(${threadId}) failed`, err);
  }
}

/** Close = archive (R3). Asks first when the thread is busy. Returns whether it was archived. */
export async function closeThread(threadId: string): Promise<boolean> {
  const found = findThread(useAppStore.getState(), threadId);
  if (!found || found.thread.archived) return false;
  if (await isBusy(threadId)) {
    const ok = await ask(`"${found.thread.title}" is still running. Closing it stops the agent and the terminal's running process.`, {
      title: "Close thread?",
      kind: "warning",
      okLabel: "Close Thread",
      cancelLabel: "Cancel",
    });
    if (!ok) return false;
  }
  await stopThread(threadId);
  useAppStore.getState().archiveThread(threadId);
  return true;
}

/** Removes a project from Speedy, stopping its threads first. Its CLI sessions stay on disk. */
export async function removeProject(projectId: string): Promise<boolean> {
  const project = useAppStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return false;
  const live = project.threads.filter((t) => !t.archived);
  const busy = (await Promise.all(live.map((t) => isBusy(t.id)))).some(Boolean);
  if (busy) {
    const ok = await ask(`A thread in "${project.name}" is still running. Removing the project stops its agents and terminals.`, {
      title: "Remove project?",
      kind: "warning",
      okLabel: "Remove Project",
      cancelLabel: "Cancel",
    });
    if (!ok) return false;
  }
  // stopThread never rejects; stop them concurrently.
  await Promise.all(live.map((t) => stopThread(t.id)));
  useAppStore.getState().removeProject(projectId);
  return true;
}

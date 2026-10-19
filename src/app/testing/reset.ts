// Resets the fake Tauri backend and the zustand stores between tests.
import type { AppState, ThreadStatus } from "../../ipc/types";
import { initialRuntime } from "../../store/reducer";
import { useAppStore } from "../../store/appStore";
import { __resetDraftsForTests } from "../../store/drafts";
import { useThreadStore } from "../../store/threadStore";
import { useTerminalTabs } from "../../terminal/tabs";
import { emptyState, resetFakeBackend } from "./tauriMock";

const initialApp = useAppStore.getState();
const initialTabs = useTerminalTabs.getState();

export function resetBackend(state: AppState = emptyState()) {
  resetFakeBackend(state);
  useAppStore.setState(initialApp, true);
  useThreadStore.setState({ threads: {} });
  useTerminalTabs.setState(initialTabs, true);
  __resetDraftsForTests();
}

/** A full thread runtime in the given status, for seeding the thread store. */
export const runtime = (status: ThreadStatus) => ({ ...initialRuntime(), status });

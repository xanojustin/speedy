// Resets the fake Tauri backend and the zustand stores between tests.
import type { AppState, ThreadStatus } from "../../ipc/types";
import { initialRuntime } from "../../store/reducer";
import { useAppStore } from "../../store/appStore";
import { useThreadStore } from "../../store/threadStore";
import { emptyState, resetFakeBackend } from "./tauriMock";

const initialApp = useAppStore.getState();

export function resetBackend(state: AppState = emptyState()) {
  resetFakeBackend(state);
  useAppStore.setState(initialApp, true);
  useThreadStore.setState({ threads: {} });
}

/** A full thread runtime in the given status, for seeding the thread store. */
export const runtime = (status: ThreadStatus) => ({ ...initialRuntime(), status });

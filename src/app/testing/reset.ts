// Resets the fake Tauri backend and the zustand stores between tests.
import type { AppState } from "../../ipc/types";
import { useAppStore } from "../../store/appStore";
import { useThreadStore } from "../../store/threadStore";
import { emptyState, resetFakeBackend } from "./tauriMock";

const initialApp = useAppStore.getState();

export function resetBackend(state: AppState = emptyState()) {
  resetFakeBackend(state);
  useAppStore.setState(initialApp, true);
  useThreadStore.setState({ threads: {} }, true);
}

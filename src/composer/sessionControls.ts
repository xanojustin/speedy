// Session-control state the CLI has acknowledged but doesn't echo back until its next system/init:
// the permission mode after a set_permission_mode ack and the effort level after apply_flag_settings.
// Kept outside the component so it survives the composer remounting on thread switches.
import { create } from "zustand";
import type { PermissionMode } from "../ipc/types";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface AckedMode {
  mode: PermissionMode;
  /** The CLI-reported mode when the ack arrived; a newer CLI report supersedes the ack. */
  basis: PermissionMode | null;
}

interface SessionControlsState {
  modes: Record<string, AckedMode>;
  effort: Record<string, EffortLevel>;
  setAckedMode(threadId: string, acked: AckedMode): void;
  setEffort(threadId: string, level: EffortLevel): void;
}

export const useSessionControls = create<SessionControlsState>((set) => ({
  modes: {},
  effort: {},
  setAckedMode: (threadId, acked) => set((s) => ({ modes: { ...s.modes, [threadId]: acked } })),
  setEffort: (threadId, level) => set((s) => ({ effort: { ...s.effort, [threadId]: level } })),
}));

export function __resetSessionControlsForTests() {
  useSessionControls.setState({ modes: {}, effort: {} });
}

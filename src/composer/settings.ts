// The `claudeCode.*` settings the composer honors.
import { useMemo } from "react";
import { useExtensionSettings } from "../ipc/extensionSettings";
import type { ExtensionSettings, PermissionMode } from "../ipc/types";

interface ComposerSettings {
  useCtrlEnterToSend: boolean;
  respectGitIgnore: boolean;
  allowDangerouslySkipPermissions: boolean;
  /**
   * Mode for new threads: the global Claude default (`permissions.defaultMode` in
   * ~/.claude/settings.json), else `claudeCode.initialPermissionMode` ("manual" = "default").
   */
  initialPermissionMode: PermissionMode | null;
  /** Model for new threads: the global Claude `model`, else `claudeCode.selectedModel`. */
  selectedModel: string | null;
  /** The global Claude `effortLevel`, which the CLI applies at spawn. */
  defaultEffort: string | null;
}

/** Every permission mode, in Shift+Tab order. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

function toComposerSettings(s: ExtensionSettings | null): ComposerSettings {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  // Global Claude defaults win over the VS Code extension's settings.
  const initial = str(s?.["claude.defaultMode"]) ?? s?.["claudeCode.initialPermissionMode"];
  const mode = initial === "manual" ? "default" : initial;
  const selected = str(s?.["claude.model"]) ?? s?.["claudeCode.selectedModel"];
  return {
    useCtrlEnterToSend: s?.["claudeCode.useCtrlEnterToSend"] === true,
    // The extension's declared default is true.
    respectGitIgnore: s?.["claudeCode.respectGitIgnore"] !== false,
    allowDangerouslySkipPermissions: s?.["claudeCode.allowDangerouslySkipPermissions"] === true,
    initialPermissionMode: PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : null,
    selectedModel: str(selected),
    defaultEffort: str(s?.["claude.effortLevel"]),
  };
}

/** Settings once read (null until then). */
export function useComposerSettings(): ComposerSettings | null {
  const settings = useExtensionSettings();
  return useMemo(() => (settings ? toComposerSettings(settings) : null), [settings]);
}

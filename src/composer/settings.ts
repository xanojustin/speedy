// The `claudeCode.*` settings the composer honors.
import { useMemo } from "react";
import { useExtensionSettings } from "../ipc/extensionSettings";
import type { ExtensionSettings, PermissionMode } from "../ipc/types";

interface ComposerSettings {
  useCtrlEnterToSend: boolean;
  respectGitIgnore: boolean;
  allowDangerouslySkipPermissions: boolean;
  /** `claudeCode.initialPermissionMode` ("manual" is the extension's alias for "default"). */
  initialPermissionMode: PermissionMode | null;
  selectedModel: string | null;
}

/** Every permission mode, in Shift+Tab order. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

function toComposerSettings(s: ExtensionSettings | null): ComposerSettings {
  const initial = s?.["claudeCode.initialPermissionMode"];
  const mode = initial === "manual" ? "default" : initial;
  const selected = s?.["claudeCode.selectedModel"];
  return {
    useCtrlEnterToSend: s?.["claudeCode.useCtrlEnterToSend"] === true,
    // The extension's declared default is true.
    respectGitIgnore: s?.["claudeCode.respectGitIgnore"] !== false,
    allowDangerouslySkipPermissions: s?.["claudeCode.allowDangerouslySkipPermissions"] === true,
    initialPermissionMode: PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : null,
    selectedModel: typeof selected === "string" && selected ? selected : null,
  };
}

/** Settings once read (null until then). */
export function useComposerSettings(): ComposerSettings | null {
  const settings = useExtensionSettings();
  return useMemo(() => (settings ? toComposerSettings(settings) : null), [settings]);
}

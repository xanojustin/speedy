// The `claudeCode.*` settings the composer honors.
import { useEffect, useState } from "react";
import { getExtensionSettings } from "../ipc/commands";
import type { ExtensionSettings, PermissionMode } from "../ipc/types";

export interface ComposerSettings {
  useCtrlEnterToSend: boolean;
  respectGitIgnore: boolean;
  allowDangerouslySkipPermissions: boolean;
  /** `claudeCode.initialPermissionMode` ("manual" is the extension's alias for "default"). */
  initialPermissionMode: PermissionMode | null;
  selectedModel: string | null;
}

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function toComposerSettings(s: ExtensionSettings | null): ComposerSettings {
  const initial = s?.["claudeCode.initialPermissionMode"];
  const mode = initial === "manual" ? "default" : initial;
  const selected = s?.["claudeCode.selectedModel"];
  return {
    useCtrlEnterToSend: s?.["claudeCode.useCtrlEnterToSend"] === true,
    // The extension's declared default is true.
    respectGitIgnore: s?.["claudeCode.respectGitIgnore"] !== false,
    allowDangerouslySkipPermissions: s?.["claudeCode.allowDangerouslySkipPermissions"] === true,
    initialPermissionMode: MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : null,
    selectedModel: typeof selected === "string" && selected ? selected : null,
  };
}

/** Settings once read (null until then); re-read on each mount so VS Code edits are picked up. */
export function useComposerSettings(): ComposerSettings | null {
  const [settings, setSettings] = useState<ComposerSettings | null>(null);
  useEffect(() => {
    let live = true;
    getExtensionSettings()
      .catch(() => null)
      .then((s) => {
        if (live) setSettings(toComposerSettings(s ?? null));
      });
    return () => {
      live = false;
    };
  }, []);
  return settings;
}

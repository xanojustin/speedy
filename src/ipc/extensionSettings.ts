// One shared read of the effective `claudeCode.*` settings for every component that honors them.
import { useEffect, useState } from "react";
import { getExtensionSettings } from "./commands";
import type { ExtensionSettings } from "./types";

// The backend computes these once at startup, so mounted readers share one fetch. The cache is
// dropped when the last reader unmounts, so the next mount reads again.
let shared: Promise<ExtensionSettings> | null = null;
let readers = 0;

/**
 * The settings once read (null until then). A failed read yields `{}`, which every reader treats
 * like an absent setting.
 */
export function useExtensionSettings(): ExtensionSettings | null {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  useEffect(() => {
    let live = true;
    readers++;
    shared ??= getExtensionSettings().catch(() => ({}));
    void shared.then((s) => {
      if (live) setSettings(s ?? {});
    });
    return () => {
      live = false;
      if (--readers === 0) shared = null;
    };
  }, []);
  return settings;
}

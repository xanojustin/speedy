// The `claudeCode.*` settings the transcript honors (spinner verbs, message timestamps).
import { useMemo } from "react";
import { useExtensionSettings } from "../ipc/extensionSettings";
import type { ExtensionSettings } from "../ipc/types";

/** The extension's built-in spinner verbs (claude-code 2.1.299 webview). */
export const DEFAULT_SPINNER_VERBS = [
  "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating",
  "Channeling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting",
  "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating",
  "Determining", "Discombobulating", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling",
  "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding",
  "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering",
  "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophizing",
  "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Schlepping",
  "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking",
  "Tinkering", "Transmuting", "Unfurling", "Unraveling", "Vibing", "Wandering", "Whirring", "Wibbling", "Working",
  "Wrangling",
];

export interface ChatSettings {
  spinnerVerbs: string[];
  showMessageTimestamps: boolean;
}

/** `claudeCode.spinnerVerbs` is `{mode: "append"|"replace", verbs}`; replace with no verbs keeps the defaults. */
export function resolveSpinnerVerbs(setting: unknown): string[] {
  if (!setting || typeof setting !== "object") return DEFAULT_SPINNER_VERBS;
  const { mode, verbs } = setting as { mode?: unknown; verbs?: unknown };
  const list = Array.isArray(verbs) ? verbs.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  if (mode === "replace") return list.length ? list : DEFAULT_SPINNER_VERBS;
  return [...DEFAULT_SPINNER_VERBS, ...list];
}

export function toChatSettings(s: ExtensionSettings | null): ChatSettings {
  return {
    spinnerVerbs: resolveSpinnerVerbs(s?.["claudeCode.spinnerVerbs"]),
    // The extension's declared default is true.
    showMessageTimestamps: s?.["claudeCode.showMessageTimestamps"] !== false,
  };
}

export function useChatSettings(): ChatSettings {
  const settings = useExtensionSettings();
  return useMemo(() => toChatSettings(settings), [settings]);
}

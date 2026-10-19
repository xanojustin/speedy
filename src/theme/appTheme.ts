// The Light / Dark / System Setting preference. It sets the app's native appearance, which every
// window's webview reports as `prefers-color-scheme`, so the theme CSS, the code highlighting and
// the terminals all follow without knowing about the setting.
import { useEffect } from "react";
import { setAppTheme } from "../ipc/commands";
import { THEME_PREFERENCES, type ThemePreference } from "../ipc/types";
import { useAppStore } from "../store/appStore";

/** A copy of the saved preference, applied at startup before `client.json` loads (no flash). */
const CACHE_KEY = "speedy.theme";

export function applyTheme(theme: ThemePreference) {
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // The cache only saves a flash at startup.
  }
  void setAppTheme(theme === "system" ? null : theme).catch((err) => console.warn("set_app_theme failed", err));
}

export function applyCachedTheme() {
  const cached = localStorage.getItem(CACHE_KEY) as ThemePreference | null;
  if (cached && cached !== "system" && THEME_PREFERENCES.includes(cached)) applyTheme(cached);
}

/** Applies the theme setting once it's loaded, and whenever it changes. */
export function useAppTheme() {
  const theme = useAppStore((s) => s.theme);
  const loaded = useAppStore((s) => s.loaded);
  useEffect(() => {
    if (loaded) applyTheme(theme);
  }, [theme, loaded]);
}

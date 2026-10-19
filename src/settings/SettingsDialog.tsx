// App settings: the theme, notifications and the attention sound. Values persist in AppState; useAttention
// pushes them to the Rust attention service.
import { useEffect, useRef } from "react";
import { HostsSettings } from "../hosts/HostsSettings";
import { playSound } from "../ipc/commands";
import { THEME_PREFERENCES, type ThemePreference } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import "./settings.css";

/** Mirrors `SOUNDS` in src-tauri/src/attention.rs (macOS system sounds). */
export const COMPLETION_SOUNDS = [
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
] as const;

const THEME_LABEL: Record<ThemePreference, string> = { light: "Light", dark: "Dark", system: "System Setting" };

const preview = (name: string) => void playSound(name).catch((err) => console.warn("sound preview failed", err));

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const notificationsEnabled = useAppStore((s) => s.notificationsEnabled);
  const completionSound = useAppStore((s) => s.completionSound);
  const theme = useAppStore((s) => s.theme);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => firstRef.current?.focus(), []);

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="settings-header">
          <h2 id="settings-title" className="settings-title">
            Settings
          </h2>
          <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
            <span className="codicon codicon-close" aria-hidden />
          </button>
        </header>

        <section className="settings-section" aria-labelledby="settings-appearance">
          <h3 id="settings-appearance" className="settings-section-title">
            Appearance
          </h3>
          <div className="settings-row">
            <span className="settings-label" id="settings-theme">
              Theme
              <span className="settings-description">System Setting follows macOS's light or dark appearance.</span>
            </span>
            <span className="settings-segmented" role="radiogroup" aria-labelledby="settings-theme">
              {THEME_PREFERENCES.map((t) => (
                <label key={t} className="settings-segment" data-checked={t === theme || undefined}>
                  <input
                    ref={t === theme ? firstRef : undefined}
                    type="radio"
                    name="settings-theme"
                    value={t}
                    checked={t === theme}
                    onChange={() => updateSettings({ theme: t })}
                  />
                  {THEME_LABEL[t]}
                </label>
              ))}
            </span>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-notifications">
          <h3 id="settings-notifications" className="settings-section-title">
            Notifications
          </h3>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={notificationsEnabled}
              onChange={(e) => updateSettings({ notificationsEnabled: e.target.checked })}
            />
            <span className="settings-label">
              Show notifications
              <span className="settings-description">When a thread you're not looking at finishes, needs your input, or crashes.</span>
            </span>
          </label>

          <div className="settings-row">
            <span className="settings-label">
              <label htmlFor="settings-sound">Attention sound</label>
              <span className="settings-description">Played whenever a thread finishes, needs your input, or crashes.</span>
            </span>
            <span className="settings-control">
              <select
                id="settings-sound"
                className="vscode-input settings-select"
                value={completionSound ?? ""}
                onChange={(e) => {
                  const sound = e.target.value || null;
                  updateSettings({ completionSound: sound });
                  if (sound) preview(sound);
                }}
              >
                <option value="">None</option>
                {COMPLETION_SOUNDS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-button"
                aria-label="Play sound"
                title="Play sound"
                disabled={!completionSound}
                onClick={() => completionSound && preview(completionSound)}
              >
                <span className="codicon codicon-play" aria-hidden />
              </button>
            </span>
          </div>
        </section>

        <HostsSettings />
      </div>
    </div>
  );
}

// Footer session controls (R10): permission-mode menu (with the effort row, as the extension
// places it), model pill + model list, and the context-usage ring.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PermissionMode } from "../ipc/types";
import type { EffortLevel } from "./sessionControls";
import { PERMISSION_MODES } from "./settings";

// ---------- permission modes ----------

const MODE_INFO: Record<PermissionMode, { label: string; description: string; icon: string }> = {
  default: { label: "Manual", description: "Claude will ask for approval before making each edit", icon: "shield" },
  acceptEdits: { label: "Edit automatically", description: "Claude will edit your selected text or the whole file", icon: "edit" },
  plan: { label: "Plan", description: "Claude will explore the code and present a plan before editing", icon: "checklist" },
  auto: {
    label: "Auto",
    description: "Claude will approve actions that pass a safety check and pause for anything risky",
    icon: "sparkle",
  },
  bypassPermissions: {
    label: "Bypass permissions",
    description: "Claude will not ask for approval before running potentially dangerous commands",
    icon: "warning",
  },
};

/** The modes the switcher offers, in Shift+Tab order. Bypass only when the setting allows it. */
export function availableModes(allowBypass: boolean): PermissionMode[] {
  return PERMISSION_MODES.filter((m) => allowBypass || m !== "bypassPermissions");
}

export function nextMode(current: PermissionMode, modes: PermissionMode[]): PermissionMode {
  const i = modes.indexOf(current);
  return modes[(i + 1) % modes.length];
}

// ---------- effort ----------

export const EFFORT_LABEL: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

export interface EffortControl {
  level: EffortLevel | null;
  levels: EffortLevel[];
  onSet(level: EffortLevel): void;
}

// ---------- models ----------

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
}

export function modelOptions(init: Record<string, unknown> | null): ModelOption[] {
  const models = init?.models;
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is ModelOption => !!m && typeof m === "object" && typeof (m as ModelOption).value === "string");
}

/** The row for a model id or alias: by value, then by the canonical id it resolves to. */
export function findModel(options: ModelOption[], model: string | null): ModelOption | undefined {
  if (!model) return undefined;
  const bare = model.replace(/\[1m\]$/i, "");
  return (
    options.find((o) => o.value === model) ??
    options.find((o) => o.value === bare) ??
    // A full model id: prefer the named entry over the "default" alias that resolves to it.
    options.find((o) => o.value !== "default" && (o.resolvedModel === model || o.resolvedModel === bare)) ??
    options.find((o) => o.resolvedModel === model || o.resolvedModel === bare)
  );
}

/** "claude-opus-5-5" -> "Opus 5.5", for a model id the CLI hasn't listed yet. */
export function prettyModelId(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(\[1m\])?$/i.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}${m[4] ? " (1M)" : ""}`;
}

// ---------- shared popup behavior ----------

/** Closes on a mousedown outside the anchor/popup or on Escape, like the extension's footer menus. */
function useDismiss(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (refs.every((r) => !r.current?.contains(e.target as Node))) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close, refs]);
}

// ---------- mode menu ----------

export function ModeMenu({
  mode,
  modes,
  onSelect,
  effort,
}: {
  mode: PermissionMode;
  modes: PermissionMode[];
  onSelect(mode: PermissionMode): void;
  effort: EffortControl | null;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const refs = useRef([button, popup]).current;
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, refs);
  const info = MODE_INFO[mode] ?? MODE_INFO.default;

  return (
    <div className="composer-menu-host">
      <button
        ref={button}
        type="button"
        className="composer-footer-button mode-button"
        data-mode={mode}
        aria-label={`Mode: ${info.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${info.description}. Click to change, or press Shift+Tab to cycle.`}
        onClick={() => setOpen((o) => !o)}
      >
        <i className={`codicon codicon-${info.icon}`} aria-hidden="true" />
        <span>{info.label}</span>
      </button>
      {open && (
        <div ref={popup} className="composer-menu composer-menu-right" role="menu" aria-label="Modes">
          <div className="composer-menu-header">
            <span className="composer-menu-title">Modes</span>
            <span className="composer-menu-hint">
              <kbd>⇧</kbd> + <kbd>tab</kbd> to switch
            </span>
          </div>
          {modes.map((m) => {
            const mi = MODE_INFO[m];
            const selected = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`composer-menu-item${selected ? " selected" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onSelect(m);
                }}
              >
                <i className={`codicon codicon-${mi.icon} composer-menu-icon`} aria-hidden="true" />
                <span className="composer-menu-text">
                  <span className="composer-menu-label">{mi.label}</span>
                  <span className="composer-menu-description">{mi.description}</span>
                </span>
                <span className="composer-menu-check">{selected && <i className="codicon codicon-check" aria-hidden="true" />}</span>
              </button>
            );
          })}
          {effort && effort.levels.length > 0 && <EffortRow effort={effort} />}
        </div>
      )}
    </div>
  );
}

function EffortRow({ effort }: { effort: EffortControl }) {
  const { level, levels, onSet } = effort;
  return (
    <>
      <div className="composer-menu-divider" />
      <div className="effort-row">
        <span className="effort-label">
          <i className="codicon codicon-dashboard" aria-hidden="true" /> Effort
          <span className="effort-level">({level ? EFFORT_LABEL[level] : "Auto"})</span>
        </span>
        <span className="effort-levels" role="radiogroup" aria-label="Effort">
          {levels.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === level}
              aria-label={EFFORT_LABEL[l]}
              title={EFFORT_LABEL[l]}
              className={`effort-dot${level && levels.indexOf(l) <= levels.indexOf(level) ? " on" : ""}`}
              onClick={() => onSet(l)}
            />
          ))}
        </span>
      </div>
    </>
  );
}

// ---------- model picker ----------

export function ModelPicker({
  label,
  effortLabel,
  options,
  current,
  onSelect,
}: {
  label: string;
  effortLabel: string | null;
  options: ModelOption[];
  current: ModelOption | undefined;
  onSelect(model: ModelOption): void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const refs = useRef([button, popup]).current;
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, refs);

  return (
    <div className="composer-menu-host">
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${label}${effortLabel ? ` ${effortLabel}` : ""}`}
        className="model-pill"
        title="Switch model"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-pill-label">{label}</span>
        {effortLabel && <span className="model-pill-effort">{effortLabel}</span>}
      </button>
      {open && (
        <div ref={popup} className="composer-menu" role="listbox" aria-label="Models">
          {options.length === 0 ? (
            <div className="composer-popup-empty">Models are available once the session starts.</div>
          ) : (
            options.map((o) => {
              const selected = o === current;
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  className={`composer-menu-item${selected ? " selected" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onSelect(o);
                  }}
                >
                  <span className="composer-menu-text">
                    <span className="composer-menu-label">{o.displayName}</span>
                    {o.description && <span className="composer-menu-description">{o.description}</span>}
                  </span>
                  <span className="composer-menu-check">{selected && <i className="codicon codicon-check" aria-hidden="true" />}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------- context usage ----------

/** `get_context_usage` response (SDKControlGetContextUsageResponse), read defensively. */
function contextPercentage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const { percentage, totalTokens, maxTokens } = usage as { percentage?: unknown; totalTokens?: unknown; maxTokens?: unknown };
  if (typeof percentage === "number" && Number.isFinite(percentage)) return Math.min(100, Math.max(0, percentage));
  if (typeof totalTokens === "number" && typeof maxTokens === "number" && maxTokens > 0) return Math.min(100, (totalTokens / maxTokens) * 100);
  return null;
}

/** Like the extension: hidden until half the context is used; click compacts. */
export function ContextUsage({ usage, onCompact }: { usage: unknown; onCompact(): void }): ReactNode {
  const used = contextPercentage(usage);
  if (used === null || used < 50) return null;
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className="context-usage"
      aria-label={`${Math.round(used)}% context used — click to compact`}
      title={`${Math.round(100 - used)}% of context remaining until auto-compact. Click to compact now.`}
      onClick={onCompact}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1.5" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          className="context-usage-arc"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={`${(used / 100) * c} ${c}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
    </button>
  );
}

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
export function useDismiss(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[]) {
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

interface ContextCategory {
  name: string;
  tokens: number;
  kind?: "used" | "free" | "buffer" | "deferred";
}

export interface ContextSummary {
  percentage: number;
  totalTokens: number | null;
  maxTokens: number | null;
  autoCompactThreshold: number | null;
  /** What occupies the window, largest first; deferred tool schemas are left out. */
  used: ContextCategory[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `get_context_usage` response (SDKControlGetContextUsageResponse), read defensively. */
export function contextSummary(usage: unknown): ContextSummary | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const totalTokens = num(u.totalTokens);
  const maxTokens = num(u.maxTokens);
  let percentage = num(u.percentage);
  if (percentage === null && totalTokens !== null && maxTokens) percentage = (totalTokens / maxTokens) * 100;
  if (percentage === null) return null;
  const used = (Array.isArray(u.categories) ? u.categories : [])
    .filter((c): c is ContextCategory => !!c && typeof c === "object" && typeof c.name === "string" && num(c.tokens) !== null)
    // Older CLIs don't send `kind`; fall back to the names the CLI uses for the non-content rows.
    .filter((c) => (c.kind ? c.kind === "used" : !/deferred|free space|buffer/i.test(c.name)))
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  return {
    percentage: Math.min(100, Math.max(0, percentage)),
    totalTokens,
    maxTokens,
    autoCompactThreshold: u.isAutoCompactEnabled === false ? null : num(u.autoCompactThreshold),
    used,
  };
}

/** 35097 -> "35.1k", 1000000 -> "1M". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** The footer's context meter: a ring and the percentage used; click for the breakdown and Compact. */
export function ContextUsage({ usage, onCompact }: { usage: unknown; onCompact(): void }): ReactNode {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const refs = useRef([button, popup]).current;
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, refs);

  const summary = contextSummary(usage);
  if (!summary) return null;
  const { percentage, totalTokens, maxTokens, autoCompactThreshold, used } = summary;
  const shown = Math.round(percentage);
  const level = percentage >= 80 ? "high" : percentage >= 50 ? "medium" : "low";
  const r = 6;
  const c = 2 * Math.PI * r;
  const ofMax = totalTokens !== null && maxTokens ? `${formatTokenCount(totalTokens)} / ${formatTokenCount(maxTokens)} tokens` : null;

  return (
    <div className="composer-menu-host">
      <button
        ref={button}
        type="button"
        className="context-usage"
        data-level={level}
        aria-label={`${shown}% context used`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${shown}% of context used${ofMax ? ` (${ofMax})` : ""}. Click for details.`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            className="context-usage-arc"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(percentage / 100) * c} ${c}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span className="context-usage-pct">{shown}%</span>
      </button>
      {open && (
        <div ref={popup} className="composer-menu context-menu" role="dialog" aria-label="Context window">
          <div className="composer-menu-header">
            <span className="composer-menu-title">Context window</span>
            <span className="composer-menu-hint">{ofMax ?? `${shown}% used`}</span>
          </div>
          <div className="context-bar" aria-hidden="true">
            <div className="context-bar-fill" data-level={level} style={{ width: `${percentage}%` }} />
            {autoCompactThreshold !== null && maxTokens ? (
              <div className="context-bar-mark" style={{ left: `${Math.min(100, (autoCompactThreshold / maxTokens) * 100)}%` }} />
            ) : null}
          </div>
          {used.length > 0 && (
            <ul className="context-rows">
              {used.map((cat) => (
                <li key={cat.name} className="context-row">
                  <span className="context-row-name">{cat.name}</span>
                  <span className="context-row-tokens">{formatTokenCount(cat.tokens)}</span>
                </li>
              ))}
            </ul>
          )}
          {autoCompactThreshold !== null && (
            <div className="context-note">Auto-compacts at {formatTokenCount(autoCompactThreshold)} tokens.</div>
          )}
          <div className="composer-menu-divider" />
          <button
            type="button"
            className="composer-menu-item"
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            <i className="codicon codicon-fold composer-menu-icon" aria-hidden="true" />
            <span className="composer-menu-text">
              <span className="composer-menu-label">Compact conversation</span>
              <span className="composer-menu-description">Summarize the conversation so far to free up context</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

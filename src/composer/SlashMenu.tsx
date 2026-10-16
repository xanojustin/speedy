// The `/` command menu. Commands come only from the CLI: the initialize response's `commands`
// (name, description, argumentHint) plus any extra names in system/init's `slash_commands`
// (user commands and skills that arrive after initialize).

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** Merged command list, or null when the CLI hasn't reported any yet (session not started). */
export function slashCommands(init: Record<string, unknown> | null, systemInit: Record<string, unknown> | null): SlashCommand[] | null {
  const fromInit = Array.isArray(init?.commands) ? (init.commands as unknown[]) : null;
  const fromSystem = Array.isArray(systemInit?.slash_commands) ? (systemInit.slash_commands as unknown[]) : null;
  if (!fromInit && !fromSystem) return null;
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const c of fromInit ?? []) {
    if (!c || typeof c !== "object") continue;
    const { name, description, argumentHint } = c as Record<string, unknown>;
    if (typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: typeof description === "string" ? description : "",
      argumentHint: typeof argumentHint === "string" ? argumentHint : "",
    });
  }
  for (const name of fromSystem ?? []) {
    if (typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: "", argumentHint: "" });
  }
  return out;
}

/** The part after a plugin namespace: `ce-plan` for `compound-engineering:ce-plan`. */
function shortName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

/** Prefix match on the full name or, for plugin commands, the name after the namespace (like the CLI). */
export function filterSlash(commands: SlashCommand[], prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase();
  const full = commands.filter((c) => c.name.toLowerCase().startsWith(p));
  const short = commands.filter((c) => !full.includes(c) && shortName(c.name).toLowerCase().startsWith(p));
  return [...full, ...short];
}

/**
 * Expands a leading `/short-name` to its namespaced plugin command (`/ce-plan x` →
 * `/compound-engineering:ce-plan x`) when nothing else is called that and exactly one plugin
 * command is. Anything else is returned unchanged.
 */
export function expandSlash(text: string, commands: SlashCommand[] | null): string {
  const m = /^\/([^\s:]+)(?=\s|$)/.exec(text);
  if (!m || !commands) return text;
  const typed = m[1].toLowerCase();
  if (commands.some((c) => c.name.toLowerCase() === typed)) return text;
  const hits = commands.filter((c) => c.name.includes(":") && shortName(c.name).toLowerCase() === typed);
  return hits.length === 1 ? `/${hits[0].name}${text.slice(m[0].length)}` : text;
}

export function SlashMenu({
  items,
  started,
  activeIndex,
  onSelect,
  onHover,
}: {
  items: SlashCommand[];
  started: boolean;
  activeIndex: number;
  onSelect(item: SlashCommand): void;
  onHover(index: number): void;
}) {
  return (
    <div className="composer-popup" role="listbox" aria-label="Slash commands">
      {!started && <div className="composer-popup-empty">Commands are available once the session starts. Send a message to start it.</div>}
      {started && items.length === 0 && <div className="composer-popup-empty">No matching commands</div>}
      {items.length > 0 && (
        <div className="composer-popup-list">
          {items.map((c, i) => (
            <div
              key={c.name}
              id={`slash-${c.name}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`composer-popup-item${i === activeIndex ? " active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(c)}
            >
              <span className="slash-name">/{c.name}</span>
              {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
              {c.description && <span className="composer-popup-detail">{c.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

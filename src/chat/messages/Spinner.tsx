import { useEffect, useState } from "react";
import type { BackgroundTask } from "../../store/reducer";

const GLYPHS = ["·", "✢", "*", "✶", "✻", "✽"];
const FRAMES = [...GLYPHS, ...[...GLYPHS].reverse()];
const STATIC_GLYPH = "✻";
// The extension changes the verb after 2s, 3s, 5s, then every 5s.
const VERB_DELAYS = [2000, 3000, 5000];

const pick = (verbs: string[]) => verbs[Math.floor(Math.random() * verbs.length)] ?? "Working";

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** "3 agents", "1 shell", or "2 background tasks" for a mixed set. */
export function backgroundLabel(tasks: BackgroundTask[]): string {
  const n = tasks.length;
  const type = tasks.every((t) => t.taskType === tasks[0].taskType) ? tasks[0].taskType : null;
  const noun = type === "local_agent" ? "agent" : type === "local_bash" ? "shell" : "background task";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The working row. While the turn runs it cycles a verb; once the turn has ended but background
 * tasks (subagents, shells) are still running it keeps spinning and says how many are left.
 */
export function Spinner({ verbs, working = true, background = [] }: { verbs: string[]; working?: boolean; background?: BackgroundTask[] }) {
  const [reduced] = useState(prefersReducedMotion);
  const [frame, setFrame] = useState(0);
  const [verb, setVerb] = useState(() => pick(verbs));

  useEffect(() => setVerb(pick(verbs)), [verbs]);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, [reduced]);

  useEffect(() => {
    let n = 0;
    let t: ReturnType<typeof setTimeout>;
    const next = () => {
      t = setTimeout(() => {
        setVerb(pick(verbs));
        n++;
        next();
      }, VERB_DELAYS[n] ?? 5000);
    };
    next();
    return () => clearTimeout(t);
  }, [verbs]);

  const bg = background.length > 0 ? backgroundLabel(background) : null;
  const titles = background.map((t) => t.description).filter(Boolean).join("\n");
  return (
    <div className="spinner-row" role="status">
      <span className="spinner-glyph" aria-hidden="true">
        {reduced ? STATIC_GLYPH : FRAMES[frame]}
      </span>
      <span className="spinner-text" aria-hidden="true" title={working ? undefined : titles}>
        {working ? `${verb}...` : `${bg} running in the background`}
      </span>
      {working && bg && (
        <span className="spinner-bg" aria-hidden="true" title={titles}>
          · {bg} running
        </span>
      )}
      <span className="visually-hidden">{working ? "Claude is working" : `${bg} running in the background`}</span>
    </div>
  );
}

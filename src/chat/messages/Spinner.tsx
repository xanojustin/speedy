import { useEffect, useState } from "react";

const GLYPHS = ["·", "✢", "*", "✶", "✻", "✽"];
const FRAMES = [...GLYPHS, ...[...GLYPHS].reverse()];
const STATIC_GLYPH = "✻";
// The extension changes the verb after 2s, 3s, 5s, then every 5s.
const VERB_DELAYS = [2000, 3000, 5000];

const pick = (verbs: string[]) => verbs[Math.floor(Math.random() * verbs.length)] ?? "Working";

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Spinner({ verbs }: { verbs: string[] }) {
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

  return (
    <div className="spinner-row" role="status">
      <span className="spinner-glyph" aria-hidden="true">
        {reduced ? STATIC_GLYPH : FRAMES[frame]}
      </span>
      <span className="spinner-text" aria-hidden="true">
        {verb}...
      </span>
      <span className="visually-hidden">Claude is working</span>
    </div>
  );
}

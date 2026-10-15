// U7: VS Code-style terminal find widget (Cmd+F).
import { useState } from "react";

interface Props {
  /** Runs a search; returns whether there was a match. */
  onFind: (query: string, backwards: boolean, incremental: boolean) => boolean;
  onClose: () => void;
}

export function FindWidget({ onFind, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [noMatch, setNoMatch] = useState(false);
  const run = (q: string, backwards: boolean, incremental: boolean) => setNoMatch(q !== "" && !onFind(q, backwards, incremental));

  return (
    <div className="terminal-find" role="dialog" aria-label="Find in terminal">
      <input
        className={noMatch ? "terminal-find-input no-match" : "terminal-find-input"}
        aria-label="Find"
        placeholder="Find"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          run(e.target.value, false, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            run(query, e.shiftKey, false);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="terminal-find-count">{noMatch ? "No results" : ""}</span>
      <button type="button" className="codicon codicon-arrow-up" title="Previous Match (⇧Enter)" aria-label="Previous Match" onClick={() => run(query, true, false)} />
      <button type="button" className="codicon codicon-arrow-down" title="Next Match (Enter)" aria-label="Next Match" onClick={() => run(query, false, false)} />
      <button type="button" className="codicon codicon-close" title="Close (Escape)" aria-label="Close" onClick={onClose} />
    </div>
  );
}

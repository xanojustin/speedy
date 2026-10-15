// U7: WebGL renderer lifecycle (KTD3). Only a visible terminal holds a WebGL
// context; disposing the addon makes xterm fall back to its DOM renderer.
import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

/** Attaches the WebGL renderer and returns a function that detaches it. */
export function attachWebgl(term: Terminal): () => void {
  let addon: WebglAddon | null = new WebglAddon();
  const release = () => {
    const a = addon;
    addon = null;
    a?.dispose();
  };
  try {
    // A lost context (GPU reset, too many contexts) drops back to the DOM renderer.
    addon.onContextLoss(release);
    term.loadAddon(addon);
  } catch (err) {
    console.warn("WebGL renderer unavailable, using the DOM renderer", err);
    release();
  }
  return release;
}

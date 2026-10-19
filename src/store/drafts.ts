// Per-thread work in progress that lives outside the host: the composer's unsent message and the
// explorer's open file. Kept outside the components so it survives thread switches (only the
// selected thread is mounted), and saved to localStorage so it survives a restart. Pasted images
// and unsaved file edits stay in memory: they can be large, and a stale edit buffer is worse than none.
import { create } from "zustand";
import type { Snippet } from "../composer/snippets";

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  /** base64 without the data-URL prefix */
  data: string;
  dataUrl: string;
}

export interface ComposerDraft {
  text: string;
  images: Attachment[];
  snippets: Snippet[];
}

export interface ExplorerDraft {
  /** The open file, relative to the thread's folder; null shows the tree. */
  openPath: string | null;
  expanded: string[];
  /** Unsaved edits to `openPath` (memory only). */
  edit: string | null;
}

export const EMPTY_COMPOSER: ComposerDraft = Object.freeze({ text: "", images: [], snippets: [] }) as ComposerDraft;
export const EMPTY_EXPLORER: ExplorerDraft = Object.freeze({ openPath: null, expanded: [], edit: null }) as ExplorerDraft;

type Update<T> = Partial<T> | ((prev: T) => Partial<T>);

interface DraftsState {
  composer: Record<string, ComposerDraft>;
  explorer: Record<string, ExplorerDraft>;
  updateComposer(threadId: string, update: Update<ComposerDraft>): void;
  updateExplorer(threadId: string, update: Update<ExplorerDraft>): void;
  /** Drops everything kept for the thread. */
  forgetThread(threadId: string): void;
}

const STORAGE_KEY = "speedy.drafts.v1";

interface Saved {
  composer: Record<string, { text: string; snippets: Snippet[] }>;
  explorer: Record<string, { openPath: string | null; expanded: string[] }>;
}

function load(): Pick<DraftsState, "composer" | "explorer"> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Saved>;
    const composer: Record<string, ComposerDraft> = {};
    for (const [id, d] of Object.entries(raw.composer ?? {})) {
      composer[id] = { text: typeof d.text === "string" ? d.text : "", images: [], snippets: Array.isArray(d.snippets) ? d.snippets : [] };
    }
    const explorer: Record<string, ExplorerDraft> = {};
    for (const [id, d] of Object.entries(raw.explorer ?? {})) {
      explorer[id] = { openPath: typeof d.openPath === "string" ? d.openPath : null, expanded: Array.isArray(d.expanded) ? d.expanded : [], edit: null };
    }
    return { composer, explorer };
  } catch {
    return { composer: {}, explorer: {} };
  }
}

const isEmptyComposer = (d: ComposerDraft) => d.text === "" && d.images.length === 0 && d.snippets.length === 0;
const isEmptyExplorer = (d: ExplorerDraft) => d.openPath === null && d.expanded.length === 0 && d.edit === null;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Saves what survives a restart, debounced so typing doesn't write on every key. */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushDrafts();
  }, 300);
}

export function flushDrafts() {
  const { composer, explorer } = useDrafts.getState();
  const saved: Saved = { composer: {}, explorer: {} };
  for (const [id, d] of Object.entries(composer)) {
    if (d.text || d.snippets.length) saved.composer[id] = { text: d.text, snippets: d.snippets };
  }
  for (const [id, d] of Object.entries(explorer)) {
    if (d.openPath !== null || d.expanded.length) saved.explorer[id] = { openPath: d.openPath, expanded: d.expanded };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch (err) {
    console.warn("saving drafts failed", err);
  }
}

function apply<T>(map: Record<string, T>, threadId: string, empty: T, update: Update<T>, isEmpty: (v: T) => boolean): Record<string, T> {
  const prev = map[threadId] ?? empty;
  const next = { ...prev, ...(typeof update === "function" ? update(prev) : update) };
  const out = { ...map };
  if (isEmpty(next)) delete out[threadId];
  else out[threadId] = next;
  return out;
}

export const useDrafts = create<DraftsState>((set) => ({
  ...load(),

  updateComposer(threadId, update) {
    set((s) => ({ composer: apply(s.composer, threadId, EMPTY_COMPOSER, update, isEmptyComposer) }));
    scheduleSave();
  },

  updateExplorer(threadId, update) {
    set((s) => ({ explorer: apply(s.explorer, threadId, EMPTY_EXPLORER, update, isEmptyExplorer) }));
    scheduleSave();
  },

  forgetThread(threadId) {
    set((s) => {
      const composer = { ...s.composer };
      const explorer = { ...s.explorer };
      delete composer[threadId];
      delete explorer[threadId];
      return { composer, explorer };
    });
    scheduleSave();
  },
}));

if (typeof window !== "undefined") window.addEventListener("beforeunload", flushDrafts);

export function __resetDraftsForTests() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  localStorage.removeItem(STORAGE_KEY);
  useDrafts.setState({ composer: {}, explorer: {} });
}

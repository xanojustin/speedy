// Pointer-event drag reordering for sidebar rows. HTML5 drag-and-drop isn't used because
// Tauri's native file-drop handling intercepts it in the webview.
import type { PointerEvent as ReactPointerEvent } from "react";

const THRESHOLD_PX = 4;
const MARKERS = ["dragging", "drop-before", "drop-after"];

interface DragReorderOptions {
  id: string;
  event: ReactPointerEvent;
  /** The sibling elements being reordered, in order, each carrying `data-drag-id`. */
  items: () => HTMLElement[];
  onDrop: (id: string, toIndex: number) => void;
}

export function beginDragReorder({ id, event, items, onDrop }: DragReorderOptions) {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button, input, textarea, [role=menu]")) return;
  const startY = event.clientY;
  let dragging = false;
  let toIndex = -1;

  const clear = () => items().forEach((el) => el.classList.remove(...MARKERS));

  const onMove = (e: PointerEvent) => {
    if (!dragging && Math.abs(e.clientY - startY) < THRESHOLD_PX) return;
    dragging = true;
    const all = items();
    const others = all.filter((el) => el.dataset.dragId !== id);
    toIndex = others.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2 < e.clientY;
    }).length;
    clear();
    all.find((el) => el.dataset.dragId === id)?.classList.add("dragging");
    if (toIndex < others.length) others[toIndex].classList.add("drop-before");
    else others.at(-1)?.classList.add("drop-after");
  };

  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    clear();
    if (!dragging) return;
    suppressNextClick();
    if (commit && toIndex >= 0) onDrop(id, toIndex);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/** The click that follows a drag's pointerup must not select or collapse the dragged row. */
function suppressNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

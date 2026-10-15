import type { ViewBlock } from "../../store/threadStore";

/** Position of a block in a run of timeline (assistant-side) blocks, for the connecting line. */
export interface TimelinePos {
  prev: boolean;
  next: boolean;
}

export const isTimeline = (b: ViewBlock | undefined) =>
  !!b && (b.kind === "text" || b.kind === "thinking" || b.kind === "tool" || b.kind === "error");

export function timelinePos(list: ViewBlock[], i: number): TimelinePos {
  return { prev: isTimeline(list[i - 1]), next: isTimeline(list[i + 1]) };
}

export function timelineClass(pos: TimelinePos) {
  return `timeline${pos.prev ? " tl-prev" : ""}${pos.next ? " tl-next" : ""}`;
}

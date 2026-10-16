// The virtualized transcript for one thread: view blocks, then inline permission cards, the
// thread-level error card, and the working spinner. Sticks to the bottom while the user is there.
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PermissionCard } from "../permissions/PermissionCard";
import { useThreadRuntime, type ViewBlock } from "../store/threadStore";
import { ErrorCard, showsErrorCard } from "./ErrorCard";
import { BlockView, type UserStamp } from "./messages/BlockView";
import { Spinner } from "./messages/Spinner";
import { timelinePos } from "./messages/timeline";
import { useChatSettings } from "./settings";

type Row =
  | { key: string; type: "block"; block: ViewBlock; index: number; stamp: UserStamp | null }
  | { key: string; type: "permission"; requestId: string }
  | { key: string; type: "error-card" }
  | { key: string; type: "spinner" };

const STICK_THRESHOLD = 40;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

interface StampParts {
  ts: number;
  time: string;
  day: string;
  date: string;
}
/** Formatted parts per user block; blocks are immutable, so this survives every transcript update. */
const stampCache = new WeakMap<ViewBlock, StampParts>();

function stampParts(b: ViewBlock, ts: number): StampParts {
  let parts = stampCache.get(b);
  if (!parts || parts.ts !== ts) {
    const d = new Date(ts);
    parts = { ts, time: timeFmt.format(d), day: d.toDateString(), date: dateFmt.format(d) };
    stampCache.set(b, parts);
  }
  return parts;
}

function userStamps(blocks: ViewBlock[], enabled: boolean): Map<string, UserStamp> {
  const out = new Map<string, UserStamp>();
  if (!enabled) return out;
  let lastDay: string | null = null;
  for (const b of blocks) {
    if (b.kind !== "user" || b.ts == null) continue;
    const { time, day, date } = stampParts(b, b.ts);
    out.set(b.id, { time, date: lastDay !== null && day !== lastDay ? date : null });
    lastDay = day;
  }
  return out;
}

export function Transcript({ threadId }: { threadId: string }) {
  const rt = useThreadRuntime(threadId);
  const settings = useChatSettings();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** Distance from the bottom at the last scroll or content change; kept across viewport resizes. */
  const fromBottom = useRef(0);
  /** The viewport height the scroll position was last taken at; 0 while hidden. */
  const viewHeight = useRef(0);

  const stamps = useMemo(() => userStamps(rt.blocks, settings.showMessageTimestamps), [rt.blocks, settings.showMessageTimestamps]);

  const blockRows = useMemo<Row[]>(
    () => rt.blocks.map((block, index) => ({ key: block.id, type: "block", block, index, stamp: stamps.get(block.id) ?? null })),
    [rt.blocks, stamps],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = blockRows.slice();
    for (const p of rt.pendingPermissions) out.push({ key: `perm:${p.requestId}`, type: "permission", requestId: p.requestId });
    if (showsErrorCard(rt)) out.push({ key: "error-card", type: "error-card" });
    // Background agents outlive the turn's result, so they keep the spinner up after it.
    if (rt.status === "working" || rt.backgroundTasks.length > 0) out.push({ key: "spinner", type: "spinner" });
    return out;
  }, [rt, blockRows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 6,
    paddingStart: 20,
    paddingEnd: 40,
    getItemKey: (i) => rows[i].key,
  });

  const totalSize = virtualizer.getTotalSize();
  // Sending a message jumps back to the bottom, as in the extension.
  const lastUserId = useMemo(() => {
    for (let i = rt.blocks.length - 1; i >= 0; i--) if (rt.blocks[i].kind === "user") return rt.blocks[i].id;
    return null;
  }, [rt.blocks]);
  const seenUser = useRef(lastUserId);
  if (seenUser.current !== lastUserId) {
    seenUser.current = lastUserId;
    stick.current = true;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current && rows.length > 0) el.scrollTop = el.scrollHeight;
    if (el.clientHeight > 0) fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
  }, [rows, totalSize]);

  // Opening, closing or maximizing the terminal (and dragging the sash or composer growth) resizes
  // the viewport from below. Keep the same distance from the bottom, so the line next to the
  // terminal stays put and a transcript at the bottom stays there. While hidden it has no height;
  // the position is restored when it reappears.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    viewHeight.current = el.clientHeight;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h === viewHeight.current) return;
      viewHeight.current = h;
      if (h === 0) return;
      el.scrollTop = stick.current ? el.scrollHeight : el.scrollHeight - h - fromBottom.current;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    // Scrolls caused by a resize (the browser clamping, or hiding resetting it) aren't the user's;
    // the observer above restores the position instead.
    if (!el || el.clientHeight === 0 || el.clientHeight !== viewHeight.current) return;
    fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = fromBottom.current < STICK_THRESHOLD;
  };

  const render = (row: Row): ReactNode => {
    switch (row.type) {
      case "block":
        // BlockView's memo compares pos/stamp by field, so rows whose block didn't change skip rendering.
        return <BlockView block={row.block} pos={timelinePos(rt.blocks, row.index)} stamp={row.stamp} threadId={threadId} />;
      case "permission":
        return <PermissionCard threadId={threadId} requestId={row.requestId} />;
      case "error-card":
        return <ErrorCard threadId={threadId} />;
      case "spinner":
        return <Spinner verbs={settings.spinnerVerbs} working={rt.status === "working"} background={rt.backgroundTasks} />;
    }
  };

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll} tabIndex={-1}>
      <div className="transcript-inner" style={{ height: totalSize }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className={`transcript-row row-${row.type}`}
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {render(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

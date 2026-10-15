// The virtualized transcript for one thread: view blocks, then inline permission cards, the
// thread-level error card, and the working spinner. Sticks to the bottom while the user is there.
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
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

  const stamps = useMemo(() => userStamps(rt.blocks, settings.showMessageTimestamps), [rt.blocks, settings.showMessageTimestamps]);

  const blockRows = useMemo<Row[]>(
    () => rt.blocks.map((block, index) => ({ key: block.id, type: "block", block, index, stamp: stamps.get(block.id) ?? null })),
    [rt.blocks, stamps],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = blockRows.slice();
    for (const p of rt.pendingPermissions) out.push({ key: `perm:${p.requestId}`, type: "permission", requestId: p.requestId });
    if (showsErrorCard(rt)) out.push({ key: "error-card", type: "error-card" });
    if (rt.status === "working") out.push({ key: "spinner", type: "spinner" });
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
    if (el && stick.current && rows.length > 0) el.scrollTop = el.scrollHeight;
  }, [rows, totalSize]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
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
        return <Spinner verbs={settings.spinnerVerbs} />;
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

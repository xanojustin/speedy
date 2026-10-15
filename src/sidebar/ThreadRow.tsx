import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Thread } from "../ipc/types";
import { useAppStore } from "../store/appStore";
import { useThreadStore } from "../store/threadStore";
import { StatusGlyph } from "./StatusGlyph";

interface Props {
  thread: Thread;
  selected: boolean;
  unread: boolean;
  renaming: boolean;
  onRenameDone: () => void;
  onStartRename: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
}

export function ThreadRow({ thread, selected, unread, renaming, onRenameDone, onStartRename, onContextMenu, onPointerDown }: Props) {
  const status = useThreadStore((s) => s.threads[thread.id]?.status) ?? "not_started";
  const selectThread = useAppStore((s) => s.selectThread);

  return (
    <div
      role="treeitem"
      aria-level={2}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className="thread-row sidebar-row"
      data-thread-id={thread.id}
      data-drag-id={thread.id}
      onClick={() => selectThread(thread.id)}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "F2" && !renaming) {
          e.preventDefault();
          onStartRename();
        }
      }}
    >
      <StatusGlyph status={status} unread={unread} />
      {renaming ? (
        <RenameInput initial={thread.title} onDone={onRenameDone} threadId={thread.id} />
      ) : (
        <span className="thread-title" title={thread.title} onDoubleClick={onStartRename}>
          {thread.title}
        </span>
      )}
    </div>
  );
}

function RenameInput({ initial, threadId, onDone }: { initial: string; threadId: string; onDone: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const title = value.trim();
    if (commit && title && title !== initial) useAppStore.getState().updateThread(threadId, { title });
    onDone();
  };

  return (
    <input
      ref={ref}
      className="rename-input"
      aria-label="Thread name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
    />
  );
}

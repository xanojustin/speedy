// In-DOM context menu styled like VS Code's menus.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { label: string; onSelect: () => void; swatch?: string; checked?: boolean }
  | { label: string; submenu: MenuItem[] }
  | "separator";

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} onContextMenu={(e) => e.preventDefault()}>
      <MenuPanel x={x} y={y} items={items} onClose={onClose} autoFocus />
    </div>
  );
}

interface MenuPanelProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  autoFocus: boolean;
  /** Left edge of the parent panel; a submenu that overflows the window flips to open leftward from here. */
  flipX?: number;
  /** Closes this submenu and returns focus to its parent item. */
  onBack?: () => void;
}

function MenuPanel({ x, y, items, onClose, autoFocus, flipX, onBack }: MenuPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; parentLeft: number; focus: boolean } | null>(null);

  const ownItems = () => [...(ref.current?.querySelectorAll<HTMLElement>(":scope > [role^=menuitem]") ?? [])];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keep the menu inside the window.
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${Math.max(0, (flipX ?? window.innerWidth - 4) - r.width)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
    if (autoFocus) ownItems()[0]?.focus();
  }, []);

  const openSub = (index: number, target: HTMLElement, focus: boolean) =>
    setSub({ index, rect: target.getBoundingClientRect(), parentLeft: ref.current!.getBoundingClientRect().left, focus });

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Nested panels sit inside this one in the DOM; leave their keys to them.
    if (!ownItems().includes(e.target as HTMLElement)) return;
    const index = Number((e.target as HTMLElement).dataset.index);
    const item = items[index];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const entries = ownItems();
      const i = entries.indexOf(e.target as HTMLElement);
      const next = e.key === "ArrowDown" ? (i + 1) % entries.length : (i - 1 + entries.length) % entries.length;
      entries[next]?.focus();
      setSub(null);
    } else if (e.key === "ArrowRight" && item !== "separator" && "submenu" in item) {
      e.preventDefault();
      openSub(index, e.target as HTMLElement, true);
    } else if ((e.key === "ArrowLeft" || e.key === "Escape") && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };

  const subItem = sub && items[sub.index];

  return (
    <div ref={ref} role="menu" className="context-menu" style={{ left: x, top: y }} onKeyDown={onKeyDown}>
      {items.map((item, i) => {
        if (item === "separator") return <div key={`sep-${i}`} role="separator" className="context-menu-separator" />;
        if ("submenu" in item)
          return (
            <button
              key={`${i}-${item.label}`}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={sub?.index === i}
              data-index={i}
              className={`context-menu-item${sub?.index === i ? " open" : ""}`}
              onMouseEnter={(e) => sub?.index !== i && openSub(i, e.currentTarget, false)}
              onClick={(e) => openSub(i, e.currentTarget, true)}
            >
              {item.label}
              <span className="codicon codicon-chevron-right context-menu-chevron" aria-hidden />
            </button>
          );
        return (
          <button
            key={`${i}-${item.label}`}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            data-index={i}
            className="context-menu-item"
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.checked && <span className="codicon codicon-check context-menu-check" aria-hidden />}
            {item.swatch && <span className="context-menu-swatch" style={{ background: item.swatch }} aria-hidden />}
            {item.label}
          </button>
        );
      })}
      {sub && subItem && subItem !== "separator" && "submenu" in subItem && (
        <MenuPanel
          key={sub.index}
          // Line the submenu's first item up with its parent item (the panel has 4px of padding).
          x={sub.rect.right}
          y={sub.rect.top - 5}
          flipX={sub.parentLeft}
          items={subItem.submenu}
          onClose={onClose}
          autoFocus={sub.focus}
          onBack={() => {
            ownItems().find((el) => el.dataset.index === String(sub.index))?.focus();
            setSub(null);
          }}
        />
      )}
    </div>
  );
}

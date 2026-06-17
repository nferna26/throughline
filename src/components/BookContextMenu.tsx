import { useEffect, useRef } from "react";
import TLIcon, { type IconName } from "./TLIcon";

/**
 * A calm per-book context menu (handoff §2) — the convenience entry to the
 * per-book actions (Continue reading · Show in library · Remove from library),
 * raised by right-clicking a book on the shelf or in the switcher. Remove's
 * real home is the book detail view; this is just a shortcut.
 *
 * Keyboard contract: opens with focus on the first item, ArrowUp/Down move,
 * Esc and a click outside close (returning focus to the opener), and each item
 * is a plain button so Enter/Space activate natively.
 */

export interface BookContextAction {
  key: string;
  label: string;
  icon: IconName;
  danger?: boolean;
  onSelect: () => void;
}

export default function BookContextMenu({
  x,
  y,
  actions,
  onClose,
  label = "Book actions",
}: {
  x: number;
  y: number;
  actions: BookContextAction[];
  onClose: () => void;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Land focus on the first item so the menu is immediately keyboard-drivable.
    const first = ref.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
  }, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        if (items.length === 0) return;
        const idx = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          e.key === "ArrowDown"
            ? items[(idx + 1) % items.length]
            : items[(idx - 1 + items.length) % items.length];
        next.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Clamp into the viewport so a right-click near an edge stays fully visible.
  const MENU_W = 190;
  const MENU_H = 48 + actions.length * 38;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);

  return (
    <div
      ref={ref}
      className="tl-ctx"
      role="menu"
      aria-label={label}
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {actions.map((a, i) => (
        <div key={a.key}>
          {a.danger && i > 0 && <div className="tl-ctx-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`tl-ctx-item${a.danger ? " danger" : ""}`}
            onClick={() => {
              a.onSelect();
              onClose();
            }}
          >
            <TLIcon name={a.icon} size={14} />
            {a.label}
          </button>
        </div>
      ))}
    </div>
  );
}

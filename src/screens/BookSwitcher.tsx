import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RGIcon from "../components/RGIcon";
import type { Book } from "../types";

interface Props {
  activeBook: Book;
  onSwitch: (bookId: string) => void;
  onImport: () => void;
}

/**
 * Quiet book-switcher chip for the book-header band. Collapsed it shows only the
 * current book's title; opening it lists every imported book (active one
 * checked) plus an "import another" escape hatch. Switching bumps the book's
 * `last_opened_at` via `cmd_set_active_book` (in the parent). Stays a single
 * calm control so the app never becomes library-first (a hard non-goal).
 */
export default function BookSwitcher({ activeBook, onSwitch, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const [books, setBooks] = useState<Book[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr(null);
    invoke<Book[]>("cmd_list_books")
      .then((list) => { if (!cancelled) setBooks(list); })
      .catch((e: any) => { if (!cancelled) setErr(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) chipRef.current?.focus();
  }

  function pick(bookId: string) {
    close(true);
    if (bookId !== activeBook.id) onSwitch(bookId);
  }

  return (
    <div
      style={{ position: "relative" }}
      ref={containerRef}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(true); } }}
    >
      <button
        ref={chipRef}
        className="rg-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Switch book"
      >
        <RGIcon name="book" size={16} />
        <span className="ttl">{activeBook.title}</span>
        <RGIcon name="chevronDown" size={15} />
      </button>

      {open && (
        <div className="rg-menu" role="menu" aria-label="Switch book" style={{ top: 40, left: 0 }}>
          {books === null && !err && <div className="rg-menu-status">Loading…</div>}
          {err && <div className="rg-menu-status" style={{ color: "var(--rg-alert)" }}>{err}</div>}
          {books?.map((b) => {
            const active = b.id === activeBook.id;
            return (
              <button
                key={b.id}
                role="menuitemradio"
                aria-checked={active}
                className="rg-menu-item"
                onClick={() => pick(b.id)}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="bk-t">{b.title}</span>
                  {b.author && <span className="bk-a">{b.author}</span>}
                </span>
                {active && <span className="check"><RGIcon name="check" size={16} /></span>}
              </button>
            );
          })}
          <div className="rg-menu-sep" />
          <button
            role="menuitem"
            className="rg-menu-item rg-menu-add"
            onClick={() => { close(true); onImport(); }}
          >
            <RGIcon name="plus" size={16} /><span>Import another book</span>
          </button>
        </div>
      )}
    </div>
  );
}

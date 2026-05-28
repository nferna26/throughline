import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Book } from "../types";

interface Props {
  activeBook: Book;
  onSwitch: (bookId: string) => void;
  onImport: () => void;
}

/**
 * Quiet book-switcher chip for the Today header. Collapsed it shows only the
 * current book's title; opening it lists every imported book (the active one
 * checked) plus an "import another" escape hatch. Switching just bumps the
 * book's `last_opened_at` via `cmd_set_active_book` — the Today screen reflows
 * from `cmd_today`. Stays a single calm control so the app never becomes
 * library-first (a hard non-goal).
 */
export default function BookSwitcher({ activeBook, onSwitch, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const [books, setBooks] = useState<Book[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  // Re-query on each open so a freshly imported book appears without a reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr(null);
    invoke<Book[]>("cmd_list_books")
      .then((list) => { if (!cancelled) setBooks(list); })
      .catch((e: any) => { if (!cancelled) setErr(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [open]);

  // Click outside the chip+menu closes it (menu pattern, not a modal — no trap).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
      className="book-switcher"
      ref={containerRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.stopPropagation(); close(true); }
      }}
    >
      <button
        ref={chipRef}
        className="book-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Switch book"
      >
        <span className="book-chip-glyph" aria-hidden="true">📖</span>
        <span className="book-chip-title">{activeBook.title}</span>
        <span className="book-chip-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="book-menu" role="menu" aria-label="Switch book">
          {books === null && !err && <div className="book-menu-status muted small">Loading…</div>}
          {err && <div className="book-menu-status settings-err">{err}</div>}
          {books?.map((b) => {
            const active = b.id === activeBook.id;
            return (
              <button
                key={b.id}
                role="menuitemradio"
                aria-checked={active}
                className={active ? "book-menu-item is-active" : "book-menu-item"}
                onClick={() => pick(b.id)}
              >
                <span className="book-menu-check" aria-hidden="true">{active ? "✓" : ""}</span>
                <span className="book-menu-text">
                  <span className="book-menu-title">{b.title}</span>
                  {b.author && <span className="book-menu-author">{b.author}</span>}
                </span>
              </button>
            );
          })}
          <div className="book-menu-sep" role="separator" />
          <button
            role="menuitem"
            className="book-menu-item book-menu-import"
            onClick={() => { close(true); onImport(); }}
          >
            + Import another book…
          </button>
        </div>
      )}
    </div>
  );
}

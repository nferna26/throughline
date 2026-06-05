import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import type { Book } from "../types";

interface Props {
  activeBook: Book;
  onSwitch: (bookId: string) => void;
  /** Open the public-domain catalogue (the primary "get a book" path). */
  onDiscover: () => void;
  /** Import a local .txt/.epub via the file picker (the secondary path). */
  onImport: () => void;
}

/**
 * Quiet book-switcher chip for the book-header band. Collapsed it shows only the
 * current book's title; opening it lists every imported book (active one
 * checked) plus two escape hatches — find a new book in the catalogue, or import
 * a local file. Switching bumps the book's `last_opened_at` via
 * `cmd_set_active_book` (in the parent). Stays a single calm control so the app
 * never becomes library-first (a hard non-goal).
 */
export default function BookSwitcher({ activeBook, onSwitch, onDiscover, onImport }: Props) {
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
        className="tl-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Switch book"
      >
        <TLIcon name="book" size={16} />
        <span className="ttl">{activeBook.title}</span>
        <TLIcon name="chevronDown" size={15} />
      </button>

      {open && (
        <div className="tl-menu" role="menu" aria-label="Switch book" style={{ top: 40, left: 0 }}>
          {books === null && !err && <div className="tl-menu-status">Loading…</div>}
          {err && <div className="tl-menu-status" style={{ color: "var(--tl-alert)" }}>{err}</div>}
          {books?.map((b) => {
            const active = b.id === activeBook.id;
            return (
              <button
                key={b.id}
                role="menuitemradio"
                aria-checked={active}
                className="tl-menu-item"
                onClick={() => pick(b.id)}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="bk-t">{b.title}</span>
                  {b.author && <span className="bk-a">{b.author}</span>}
                </span>
                {active && <span className="check"><TLIcon name="check" size={16} /></span>}
              </button>
            );
          })}
          <div className="tl-menu-sep" />
          <button
            role="menuitem"
            className="tl-menu-item tl-menu-add"
            onClick={() => { close(true); onDiscover(); }}
          >
            <TLIcon name="search" size={16} /><span>Find another book</span>
          </button>
          <button
            role="menuitem"
            className="tl-menu-item tl-menu-add"
            onClick={() => { close(true); onImport(); }}
          >
            <TLIcon name="upload" size={16} /><span>Import a file…</span>
          </button>
        </div>
      )}
    </div>
  );
}

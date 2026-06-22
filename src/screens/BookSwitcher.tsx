import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Cover from "../components/Cover";
import TLIcon from "../components/TLIcon";
import BookContextMenu from "../components/BookContextMenu";
import { bookAriaLabel } from "../libraryProgress";
import type { Book, LibraryEntry, Provenance } from "../types";

interface Props {
  activeBook: Book;
  /** Bumped by the parent when books / progress change, to re-fetch on open. */
  refreshKey: number;
  /** A book mid-undo-window — hidden from the recents list. */
  pendingRemovalId: string | null;
  onSwitch: (bookId: string) => void;
  /** "All books in your library" → the Library surface. */
  onOpenLibrary: () => void;
  /** Context menu "Show in library" → the Library surface. */
  onShowInLibrary: (bookId: string) => void;
  /** Context menu "Continue reading" → switch + open the reader. */
  onContinueReading: (bookId: string) => void;
  /** "Find a book in the catalogue" → the public-domain catalogue. */
  onDiscover: () => void;
  /** "Import a file" → the local .txt/.epub picker. */
  onImport: () => void;
  /** Context menu "Remove from library" → opens the confirmation in the parent. */
  onRemoveBook: (entry: { id: string; title: string; provenance: Provenance }) => void;
}

/**
 * The book switcher (handoff §2): the quick jump from the title-bar book button.
 * Recents first (covers + title + current location, the active one marked
 * "Now"), a jump field only once there are more than a handful, and a way
 * through to the full library. Right-click a row for the calm per-book actions
 * (Continue reading · Show in library · Remove from library). It stays a single
 * calm control so the app never becomes library-first.
 */

/** A jump/search field joins the switcher only past this many recents; below it
 *  the short list is enough. */
const JUMP_THRESHOLD = 8;

export default function BookSwitcher({
  activeBook,
  refreshKey,
  pendingRemovalId,
  onSwitch,
  onOpenLibrary,
  onShowInLibrary,
  onContinueReading,
  onDiscover,
  onImport,
  onRemoveBook,
}: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ entry: LibraryEntry; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr(null);
    invoke<LibraryEntry[]>("cmd_library")
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        // Fetch real covers for imported-with-cover books.
        for (const e of list.filter((x) => x.has_cover)) {
          invoke<string | null>("cmd_read_book_cover", { bookId: e.id })
            .then((uri) => {
              if (!cancelled && uri) setCovers((prev) => (prev[e.id] ? prev : { ...prev, [e.id]: uri }));
            })
            .catch(() => {});
        }
      })
      .catch((e: any) => {
        if (!cancelled) setErr(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // A click outside closes the switcher — unless the context menu (which
        // renders in a portal-like fixed layer inside the container) is up.
        if (!menu) setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, menu]);

  function close(restoreFocus: boolean) {
    setOpen(false);
    setMenu(null);
    setQuery("");
    if (restoreFocus) chipRef.current?.focus();
  }

  function pick(bookId: string) {
    close(true);
    if (bookId !== activeBook.id) onSwitch(bookId);
  }

  // Recents: every started book, most-recently-opened first, minus a book that's
  // mid-removal. The active one is marked "Now".
  const recents = (entries ?? [])
    .filter((e) => e.id !== pendingRemovalId)
    .slice()
    .sort((a, b) => {
      if (a.is_active) return -1;
      if (b.is_active) return 1;
      const ax = a.last_opened_at ?? "";
      const bx = b.last_opened_at ?? "";
      return ax < bx ? 1 : ax > bx ? -1 : 0;
    });
  const showJump = recents.length > JUMP_THRESHOLD;
  const q = query.trim().toLowerCase();
  const shown = q
    ? recents.filter(
        (e) => e.title.toLowerCase().includes(q) || (e.author ?? "").toLowerCase().includes(q),
      )
    : recents;

  return (
    <div
      style={{ position: "relative", minWidth: 0 }}
      ref={containerRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open && !menu) {
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={chipRef}
        className="tl-chip"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Switch book"
      >
        <TLIcon name="book" size={16} />
        <span className="ttl" title={activeBook.title}>{activeBook.title}</span>
        <TLIcon name="chevronDown" size={15} />
      </button>

      {open && (
        <div className="tl-switcher" aria-label="Switch book">
          <div className="tl-switcher-section">
            <p className="tl-switcher-head">Recent</p>
            {entries === null && !err && <div className="tl-menu-status">Loading…</div>}
            {err && (
              <div className="tl-menu-status" style={{ color: "var(--tl-alert)" }}>
                {err}
              </div>
            )}
            {showJump && (
              <div className="tl-switcher-jump">
                <TLIcon name="search" size={14} />
                <input
                  type="search"
                  className="tl-switcher-jump-input"
                  placeholder="Jump to a book"
                  aria-label="Jump to a book"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
            {shown.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`tl-switcher-row${b.is_active ? " active" : ""}`}
                aria-label={bookAriaLabel(b.title, b.author, b.finished)}
                onClick={() => pick(b.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ entry: b, x: e.clientX, y: e.clientY });
                }}
              >
                <Cover
                  title={b.title}
                  author={b.author}
                  size="mini"
                  className="tl-switcher-cover"
                  coverSrc={b.has_cover ? covers[b.id] : undefined}
                />
                <span className="tl-switcher-meta">
                  <span className="tl-switcher-title">{b.title}</span>
                  {b.location && <span className="tl-switcher-loc">{b.location}</span>}
                </span>
                {b.is_active && <span className="tl-switcher-now">Now</span>}
              </button>
            ))}
            {q && shown.length === 0 && <div className="tl-menu-status">No matches</div>}
          </div>
          <button type="button" className="tl-switcher-all" onClick={() => { close(true); onOpenLibrary(); }}>
            <TLIcon name="columns" size={15} /> All books in your library
          </button>
          <div className="tl-switcher-add">
            <button type="button" className="tl-switcher-addrow" onClick={() => { close(true); onDiscover(); }}>
              <TLIcon name="search" size={15} /> Find a book in the catalogue
            </button>
            <button type="button" className="tl-switcher-addrow" onClick={() => { close(true); onImport(); }}>
              <TLIcon name="upload" size={15} /> Import a file
            </button>
          </div>
        </div>
      )}

      {menu && (
        <BookContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.entry.title}`}
          onClose={() => setMenu(null)}
          actions={[
            {
              key: "continue",
              label: "Continue reading",
              icon: "arrowRight",
              onSelect: () => {
                close(false);
                onContinueReading(menu.entry.id);
              },
            },
            {
              key: "show",
              label: "Show in library",
              icon: "columns",
              onSelect: () => {
                close(false);
                onShowInLibrary(menu.entry.id);
              },
            },
            {
              key: "remove",
              label: "Remove from library",
              icon: "trash",
              danger: true,
              onSelect: () => {
                close(false);
                onRemoveBook({ id: menu.entry.id, title: menu.entry.title, provenance: menu.entry.provenance });
              },
            },
          ]}
        />
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Cover from "../components/Cover";
import TLIcon from "../components/TLIcon";
import BookContextMenu from "../components/BookContextMenu";
import { bookAriaLabel, featuredProgressLine } from "../libraryProgress";
import type { LibraryEntry, TodayCard } from "../types";

/**
 * The library surface (handoff §1) — one calm, scrollable shelf of the books a
 * reader has STARTED. Never a backlog or a collection: a book lands here only
 * when it has a plan. Top to bottom: a header + quiet count, the active book
 * featured ("Reading now"), a Reading shelf, then a quiet Finished shelf on the
 * same wall. Provenance is carried entirely by cover reality (a real embedded
 * cover reads as "mine"); there are NO shelf badges and NO two visual classes.
 *
 * Progress is a hairline LENGTH + a human phrase — never a percent, page, or
 * timer. The grid densifies (6-up, titles drop away) once the shelf outgrows a
 * screen, and a single search field joins the header only past a large library.
 */

interface Props {
  /** The active book's full card — the featured card's precise human progress
   *  line comes from here so it matches Today exactly. */
  today: TodayCard | null;
  /** Bumped by the parent after an import / removal / switch to re-fetch. */
  refreshKey: number;
  /** A book mid-undo-window: hidden from the shelf until the window resolves. */
  pendingRemovalId: string | null;
  /** Featured "Continue reading" → straight into the reader. */
  onContinueReading: () => void;
  /** Open a shelf book → switch to it and continue reading. */
  onOpenBook: (bookId: string) => void;
  /** Right-click → Remove from library (opens the confirmation in the parent). */
  onRequestRemove: (entry: LibraryEntry) => void;
  /** "Browse the library" / "Add a book" → the public-domain catalogue. */
  onBrowse: () => void;
  /** "Import a file" → the local .txt/.epub picker. */
  onImport: () => void;
}

/** Fetch the embedded cover (a data: URI) for every entry that has one, cached
 *  by book id. Cloth books need no fetch; the map is empty for them. */
function useBookCovers(entries: LibraryEntry[]): Record<string, string> {
  const [covers, setCovers] = useState<Record<string, string>>({});
  const wanted = entries
    .filter((e) => e.has_cover)
    .map((e) => e.id)
    .join(",");
  useEffect(() => {
    let cancelled = false;
    const ids = wanted ? wanted.split(",") : [];
    for (const id of ids) {
      invoke<string | null>("cmd_read_book_cover", { bookId: id })
        .then((uri) => {
          if (!cancelled && uri) setCovers((prev) => (prev[id] ? prev : { ...prev, [id]: uri }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [wanted]);
  return covers;
}

function byRecency(a: LibraryEntry, b: LibraryEntry): number {
  const ax = a.last_opened_at ?? "";
  const bx = b.last_opened_at ?? "";
  return ax < bx ? 1 : ax > bx ? -1 : 0;
}

export default function Library({
  today,
  refreshKey,
  pendingRemovalId,
  onContinueReading,
  onOpenBook,
  onRequestRemove,
  onBrowse,
  onImport,
}: Props) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ entry: LibraryEntry; x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<LibraryEntry[]>("cmd_library")
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const visible = useMemo(
    () => (entries ?? []).filter((e) => e.id !== pendingRemovalId),
    [entries, pendingRemovalId],
  );
  const covers = useBookCovers(visible);

  if (entries === null) {
    return <div className="tl-library-status">Gathering your books…</div>;
  }

  const total = visible.length;
  if (total === 0) {
    return <EmptyLibrary onBrowse={onBrowse} />;
  }

  // Sizing: a few books read full (4-up); past a screen the grid densifies to a
  // 6-up wall and titles drop away (the cover carries identity); a single search
  // field joins the header only once even the dense wall outgrows a screen.
  const dense = total > 16;
  const canSearch = total > 48;
  const q = query.trim().toLowerCase();
  const searching = canSearch && q.length > 0;
  const matches = (e: LibraryEntry) =>
    !q || e.title.toLowerCase().includes(q) || (e.author ?? "").toLowerCase().includes(q);

  const featured = visible.find((e) => e.is_active) ?? null;
  const reading = visible
    .filter((e) => !e.is_active && !e.finished)
    .filter(matches)
    .sort(byRecency);
  const finished = visible
    .filter((e) => !e.is_active && e.finished)
    .filter(matches)
    .sort(byRecency);

  return (
    <div className="tl-library" role="region" aria-label="Your library">
      <div className="tl-library-top">
        <div className="tl-library-head">
          <h1 className="tl-library-title">Your library</h1>
          <span className="tl-library-count">
            {total} {total === 1 ? "book" : "books"}
          </span>
          <span className="tl-library-add">
            <button type="button" className="tl-btn tl-btn-ghost tl-library-add-primary" onClick={onBrowse}>
              <TLIcon name="plus" size={15} /> Add a book
            </button>
            <button type="button" className="tl-link-quiet" onClick={onImport}>
              Import a file
            </button>
          </span>
        </div>
        {canSearch && (
          <div className="tl-library-search">
            <TLIcon name="search" size={15} />
            <input
              type="search"
              className="tl-library-search-input"
              placeholder="Find a book in your library"
              aria-label="Find a book in your library"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="tl-library-scroll">
        {featured && today && !searching && (
          <FeaturedCard
            entry={featured}
            card={today}
            cover={covers[featured.id]}
            onContinue={onContinueReading}
          />
        )}

        {reading.length > 0 && (
          <Shelf
            name="Reading"
            count={reading.length}
            books={reading}
            dense={dense}
            covers={covers}
            onOpenBook={onOpenBook}
            onContextMenu={(entry, x, y) => setMenu({ entry, x, y })}
          />
        )}

        {finished.length > 0 && (
          <Shelf
            name="Finished"
            count={finished.length}
            books={finished}
            dense={dense}
            covers={covers}
            onOpenBook={onOpenBook}
            onContextMenu={(entry, x, y) => setMenu({ entry, x, y })}
            second
          />
        )}

        {searching && reading.length === 0 && finished.length === 0 && (
          <p className="tl-library-nomatch">Nothing in your library matches “{query}”.</p>
        )}
      </div>

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
              onSelect: () => onOpenBook(menu.entry.id),
            },
            {
              key: "remove",
              label: "Remove from library",
              icon: "trash",
              danger: true,
              onSelect: () => onRequestRemove(menu.entry),
            },
          ]}
        />
      )}
    </div>
  );
}

function FeaturedCard({
  entry,
  card,
  cover,
  onContinue,
}: {
  entry: LibraryEntry;
  card: TodayCard;
  cover: string | undefined;
  onContinue: () => void;
}) {
  return (
    <div className="tl-feature">
      <Cover
        title={entry.title}
        author={entry.author}
        size="shelf"
        className="tl-feature-cover"
        coverSrc={entry.has_cover ? cover : undefined}
      />
      <div className="tl-feature-meta">
        <p className="tl-feature-eyebrow">Reading now</p>
        <p className="tl-feature-title">{entry.title}</p>
        {entry.author && <p className="tl-feature-author">{entry.author}</p>}
        <p className="tl-feature-progress">{featuredProgressLine(card)}</p>
        <button type="button" className="tl-btn tl-btn-primary tl-feature-continue" onClick={onContinue}>
          <TLIcon name="arrowRight" size={15} /> Continue reading
        </button>
      </div>
    </div>
  );
}

function Shelf({
  name,
  count,
  books,
  dense,
  covers,
  onOpenBook,
  onContextMenu,
  second,
}: {
  name: string;
  count: number;
  books: LibraryEntry[];
  dense: boolean;
  covers: Record<string, string>;
  onOpenBook: (bookId: string) => void;
  onContextMenu: (entry: LibraryEntry, x: number, y: number) => void;
  second?: boolean;
}) {
  return (
    <>
      <div className={`tl-shelf-label${second ? " second" : ""}`}>
        <h3 className="tl-shelf-name">{name}</h3>
        <span className="tl-shelf-count">{count}</span>
      </div>
      <div className={`tl-shelf-grid ${dense ? "many" : "few"}`}>
        {books.map((b) => (
          <ShelfBook
            key={b.id}
            book={b}
            dense={dense}
            cover={covers[b.id]}
            onOpen={() => onOpenBook(b.id)}
            onContextMenu={(x, y) => onContextMenu(b, x, y)}
          />
        ))}
      </div>
    </>
  );
}

function ShelfBook({
  book,
  dense,
  cover,
  onOpen,
  onContextMenu,
}: {
  book: LibraryEntry;
  dense: boolean;
  cover: string | undefined;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  return (
    <button
      type="button"
      className={`tl-book${book.finished ? " fin" : ""}`}
      aria-label={bookAriaLabel(book.title, book.author, book.finished)}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <Cover
        title={book.title}
        author={book.author}
        size={dense ? "search" : "shelf"}
        coverSrc={book.has_cover ? cover : undefined}
        finished={book.finished}
      />
      {!dense && (
        <>
          <h4 className="tl-book-title">{book.title}</h4>
          {book.author && <p className="tl-book-author">{book.author}</p>}
          {!book.finished && (
            <div className="tl-book-prog" aria-hidden="true">
              <i style={{ width: `${Math.max(0, Math.min(1, book.fraction)) * 100}%` }} />
            </div>
          )}
        </>
      )}
    </button>
  );
}

function EmptyLibrary({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="tl-library-empty">
      <div className="tl-library-empty-stack" aria-hidden="true">
        <Cover title="A Field Guide" author="Rivers" size="shelf" cloth={2} />
        <Cover title="Meditations" author="Aurelius" size="shelf" cloth={1} />
        <Cover title="Walden" author="Thoreau" size="shelf" cloth={4} />
      </div>
      <h3 className="tl-library-empty-title">Your library is empty for now</h3>
      <p className="tl-library-empty-sub">The books you start will gather here.</p>
      <button type="button" className="tl-btn tl-btn-primary" onClick={onBrowse}>
        <TLIcon name="search" size={15} /> Browse the library
      </button>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Cover, { decollideCovers } from "../components/Cover";
import { errorMessage, type DiscoverBook, type DiscoverPage, type ImportOutcome } from "../types";
import { resolveShelves, indexBooks, DOORWAY_IDS, type ResolvedShelf } from "../discoverShelves";
import "./Discover.css";

interface Props {
  /** Return to Today without choosing a book. */
  onBack: () => void;
  /** A book finished downloading + importing — route forward (new book → the
   *  chosen + pace step; dedup → Today). Receives the same ImportOutcome the file
   *  picker and the front-door starters use. */
  onPicked: (outcome: ImportOutcome) => void;
}

const fmtN = (n: number) => n.toLocaleString("en-US");

// Per-book download lifecycle while a cover is being opened. The catalogue source
// brand never surfaces — only "the public-domain library".
type DlState = "loading" | "error";

// ── on-device catalogue search ──
// The library opens to hand-picked editorial shelves (an empty query). Typing
// runs a debounced search and switches to the cover-forward results grid — search
// is the secondary, intent-declared affordance. cmd_discover_search is synchronous
// and network-free: it searches the WHOLE bundled catalogue, so it can never fail
// to reach the library. "Show more" appends the next page in place.
interface DiscoverState {
  query: string;
  results: DiscoverBook[];
  count: number;
  nextPage: number | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  // The whole-catalogue size, captured from the empty-query search on mount.
  // Drives the header count; never sourced from the seed. 0 until known.
  catalogueSize: number;
}

function useDiscover() {
  const [query, setQuery] = useState("");
  const [s, setS] = useState<DiscoverState>({
    query: "",
    results: [],
    count: 0,
    nextPage: null,
    status: "loading",
    loadingMore: false,
    error: null,
    catalogueSize: 0,
  });
  // Guards against out-of-order responses when the query changes mid-flight.
  const reqId = useRef(0);

  const runSearch = useCallback((q: string) => {
    const id = ++reqId.current;
    const trimmed = q.trim() || null;
    setS((prev) => ({ ...prev, query: q, error: null, status: prev.results.length ? prev.status : "loading" }));

    invoke<DiscoverPage>("cmd_discover_search", { query: trimmed, page: 1 })
      .then((page) => {
        if (id !== reqId.current) return;
        setS((prev) => ({
          query: q,
          results: page.results,
          count: page.count,
          nextPage: page.next_page,
          status: "ready",
          loadingMore: false,
          error: null,
          // The empty-query count is the whole-catalogue scale — capture it once.
          catalogueSize: trimmed == null ? page.count : prev.catalogueSize,
        }));
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setS((prev) => ({ ...prev, status: "error", error: errorMessage(e) }));
      });
  }, []);

  // Initial load (captures the catalogue size) + debounced re-search per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => runSearch(query), query === "" ? 0 : 300);
    return () => clearTimeout(handle);
  }, [query, runSearch]);

  const loadMore = useCallback(() => {
    setS((prev) => {
      if (prev.nextPage == null || prev.loadingMore) return prev;
      const id = ++reqId.current;
      const page = prev.nextPage;
      invoke<DiscoverPage>("cmd_discover_search", { query: prev.query.trim() || null, page })
        .then((res) => {
          if (id !== reqId.current) return;
          setS((cur) => ({
            ...cur,
            results: [...cur.results, ...res.results],
            nextPage: res.next_page,
            loadingMore: false,
          }));
        })
        .catch((e) => {
          if (id !== reqId.current) return;
          setS((cur) => ({ ...cur, loadingMore: false, error: errorMessage(e) }));
        });
      return { ...prev, loadingMore: true };
    });
  }, []);

  return {
    query,
    setQuery,
    results: s.results,
    count: s.count,
    nextPage: s.nextPage,
    status: s.status,
    loadingMore: s.loadingMore,
    error: s.error,
    catalogueSize: s.catalogueSize,
    runSearch,
    loadMore,
  };
}

// Hydrate the curated doorways. The editorial map (discoverShelves.ts) carries
// the ids + authored title/author/blurb; the catalogue rows (import URLs) come
// from a single by-id lookup over the whole on-device catalogue — so a doorway
// can curate ANY of the ~77k books, not only the 200 most popular. Picks whose id
// is missing simply drop from their shelf.
function useShelves() {
  const [shelves, setShelves] = useState<ResolvedShelf[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<DiscoverBook[]>("cmd_discover_books_by_ids", { ids: DOORWAY_IDS })
      .then((rows) => {
        if (!cancelled) setShelves(resolveShelves(indexBooks(rows)));
      })
      .catch(() => {
        if (!cancelled) setShelves([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return shelves;
}

export default function Discover({ onBack, onPicked }: Props) {
  const d = useDiscover();
  const shelves = useShelves();
  const [dl, setDl] = useState<Record<number, DlState>>({});
  // A failed open speaks up rather than silently failing (FT-30). One screen-level
  // line; cleared the moment the reader tries again.
  const [getError, setGetError] = useState<string | null>(null);

  // Take a book off the shelf: download + import through the owned path, then hand
  // the outcome forward (created → the chosen + pace step; dedup → Today). Picking
  // navigates away, so there's no lingering "in library" state to track.
  function startReading(b: DiscoverBook, title: string) {
    if (dl[b.id] === "loading") return;
    if (!b.has_txt && !b.has_epub) return; // nothing importable
    setGetError(null);
    setDl((m) => ({ ...m, [b.id]: "loading" }));
    invoke<ImportOutcome>("cmd_import_from_gutendex", {
      book: { txt_url: b.txt_url, epub_url: b.epub_url },
    })
      .then((outcome) => {
        onPicked(outcome);
      })
      .catch((e) => {
        const why = errorMessage(e);
        setGetError(
          why && why !== "(no error)"
            ? `Couldn't open “${title}” — ${why} Check your connection, then try again.`
            : `Couldn't open “${title}” — check your connection, then try again.`,
        );
        setDl((m) => ({ ...m, [b.id]: "error" }));
      });
  }

  const searching = d.query.trim().length > 0;
  // The search grid reflows, so de-collide with a rolling window: each cover
  // avoids its recent neighbours' colours (the most visible adjacency), keeping
  // covers shown together visibly distinct without forcing all-distinct on a long
  // list. Curated shelf rows (above) get the all-distinct treatment instead.
  const resultCloth = decollideCovers(
    d.results.map((b) => ({ title: b.title, author: b.author })),
    2,
  );

  return (
    <div className="tl-body">
      <div className="tl-library">
        <div className="tl-lib-top">
          <div className="tl-lib-h">
            <button className="tl-lib-back" onClick={onBack} aria-label="Back to Today">
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5l-5 5 5 5" />
              </svg>
              Back
            </button>
            <h1 className="tl-lib-title">The library</h1>
            {d.catalogueSize > 0 && (
              <span className="tl-lib-count">{fmtN(d.catalogueSize)} free books</span>
            )}
          </div>
          <div className={"tl-lib-search" + (searching ? " on" : "")}>
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="9" cy="9" r="5.5" />
              <path d="M13.5 13.5L17 17" />
            </svg>
            <input
              value={d.query}
              placeholder="Search by title or author"
              aria-label="Search the library by title or author"
              onChange={(e) => d.setQuery(e.target.value)}
            />
            {searching && (
              <button className="tl-lib-clear" onClick={() => d.setQuery("")} aria-label="Clear search">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="tl-lib-scroll">
          {getError && (
            <p className="tl-lib-geterror" role="alert">{getError}</p>
          )}

          {/* ── Idle: the curated doorways are the navigation ── */}
          {!searching ? (
            shelves.length > 0 ? (
              shelves.map((shelf) => {
                // De-collide the row so no two covers shown together share a colour.
                const rowCloth = decollideCovers(
                  shelf.items.map((it) => ({ title: it.title, author: it.author })),
                );
                return (
                <section className="tl-shelf" key={shelf.key} aria-label={shelf.title}>
                  <div className="tl-shelf-h">
                    <h2 className="tl-shelf-label">{shelf.title}</h2>
                    <span className="tl-shelf-desc">{shelf.description}</span>
                  </div>
                  <div className="tl-shelf-grid">
                    {shelf.items.map(({ book, title, author, blurb }, idx) => (
                      <button
                        type="button"
                        key={book.id}
                        className={"tl-book tl-cell" + (dl[book.id] === "loading" ? " is-loading" : "")}
                        onClick={() => startReading(book, title)}
                        disabled={dl[book.id] === "loading"}
                        aria-label={`Start reading ${title} by ${author}`}
                        aria-busy={dl[book.id] === "loading"}
                      >
                        <Cover title={title} author={author} size="shelf" cloth={rowCloth[idx]} />
                        <span className="tl-cell-t">{title}</span>
                        <span className="tl-cell-a">{author}</span>
                        <span className="tl-cell-blurb">{blurb}</span>
                        {dl[book.id] === "loading" && <span className="tl-cell-loading">Opening…</span>}
                      </button>
                    ))}
                  </div>
                </section>
                );
              })
            ) : (
              <div className="tl-lib-empty">
                <span>Gathering the shelves…</span>
              </div>
            )
          ) : (
            /* ── Active query: the cover-forward results grid (cover + title +
                 author only — the index has no blurbs, so none is shown) ── */
            <>
              <p className="tl-lib-meta">Sorted by how often they're read</p>
              <span className="tl-sr-only" aria-live="polite">
                {d.status === "error"
                  ? "Couldn't search the library"
                  : `${fmtN(d.count)} result${d.count === 1 ? "" : "s"} for ${d.query.trim()}`}
              </span>

              {d.status === "error" ? (
                <div className="tl-lib-empty" role="alert">
                  <span className="big">Something went wrong searching</span>
                  <span>Your imported books aren't affected. Try the search again.</span>
                  <button className="tl-lib-retry" onClick={() => d.runSearch(d.query)}>Try again</button>
                </div>
              ) : d.status === "loading" && d.results.length === 0 ? (
                <div className="tl-lib-empty"><span>Searching the library…</span></div>
              ) : d.results.length === 0 ? (
                <div className="tl-lib-empty">
                  <span className="big">No match in the library</span>
                  <span>Nothing for “{d.query.trim()}” — try another title or author.</span>
                  <button className="tl-lib-retry" onClick={() => d.setQuery("")}>Back to the shelves</button>
                </div>
              ) : (
                <>
                  <div className="tl-results-grid">
                    {d.results.map((b, idx) => {
                      const importable = b.has_txt || b.has_epub;
                      return (
                        <button
                          type="button"
                          key={b.id}
                          className={"tl-book tl-cell sch" + (dl[b.id] === "loading" ? " is-loading" : "")}
                          onClick={() => startReading(b, b.title)}
                          disabled={!importable || dl[b.id] === "loading"}
                          aria-label={`Start reading ${b.title}${b.author ? ` by ${b.author}` : ""}`}
                          aria-busy={dl[b.id] === "loading"}
                        >
                          <Cover title={b.title} author={b.author} size="search" cloth={resultCloth[idx]} />
                          <span className="tl-cell-t">{b.title}</span>
                          <span className="tl-cell-a">{b.author || "Unknown author"}</span>
                          {dl[b.id] === "loading" && <span className="tl-cell-loading">Opening…</span>}
                        </button>
                      );
                    })}
                  </div>

                  {d.nextPage != null && (
                    <div className="tl-lib-more">
                      <button className="tl-btn tl-btn-ghost" onClick={d.loadMore} disabled={d.loadingMore}>
                        {d.loadingMore ? "Loading…" : "Show more"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

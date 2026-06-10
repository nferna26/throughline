import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import { errorMessage, type DiscoverBook, type DiscoverPage, type ImportOutcome } from "../types";
import { resolveShelves, indexBooks, type ResolvedShelf } from "../discoverShelves";
import "./Discover.css";

interface Props {
  /** Return to Today without importing. */
  onBack: () => void;
  /** A book finished downloading + importing — route to plan setup (or Today on
   *  a dedup). Receives the same ImportOutcome as the file picker. */
  onPicked: (outcome: ImportOutcome) => void;
}

const fmtN = (n: number) => n.toLocaleString("en-US");

// Per-book download lifecycle. The catalogue source brand never surfaces — only
// "the public-domain library".
type DlState = "idle" | "loading" | "done" | "error";

// ── on-device catalogue search ──
// Discover opens to hand-authored editorial shelves (an empty query). Typing
// runs a debounced search and switches to the ranked results list — search is
// the secondary, intent-declared affordance. cmd_discover_search is now
// synchronous and network-free: it searches the WHOLE bundled catalogue, so it
// can never fail to reach the library. There is no offline path. "Load more"
// appends the next page in place.
//
// `count` from the mounted empty query is the whole-catalogue size — the live
// scale shown in the search affordance (FT-37). It is read straight from the
// response, never hardcoded.
interface DiscoverState {
  query: string;
  results: DiscoverBook[];
  count: number;
  nextPage: number | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  // The whole-catalogue size, captured from the empty-query search on mount.
  // Drives "Search all N titles"; never sourced from the seed. 0 until known.
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
    // Only show the bare spinner when we have nothing to keep on screen; an
    // existing list stays put until the next results replace it.
    setS((prev) => ({ ...prev, query: q, error: null, status: prev.results.length ? prev.status : "loading" }));

    // Search the full on-device catalogue. Synchronous + network-free, so this
    // always reaches the whole library — a zero-result is truthful absence.
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

  // Initial load + debounced re-search on every keystroke.
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

  // Expose the *live* input query (not s.query, the last query actually searched
  // — that stays internal for pagination). Pick fields explicitly so the live
  // query is never shadowed by the spread.
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

// Hydrate the curated shelves. The editorial map (discoverShelves.ts) carries
// only ids + reasons; the catalogue rows (title/author/URLs) come from the
// bundled seed. The seed paginates 32/page, so page through it once — these are
// instant, network-free, in-process calls — to build a complete id→book index
// the whole curation can join against. Shelves resolve to whatever the seed can
// actually serve; an id missing from the seed simply drops from its shelf.
function useShelves() {
  const [shelves, setShelves] = useState<ResolvedShelf[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all: DiscoverBook[] = [];
      let page: number | null = 1;
      // Bounded so a misbehaving backend can never spin here.
      for (let guard = 0; page != null && guard < 40; guard++) {
        try {
          const res: DiscoverPage = await invoke("cmd_discover_seed", { query: null, page });
          all.push(...res.results);
          page = res.next_page;
        } catch {
          break; // the bundled seed never fails, but never spin if it does
        }
      }
      if (!cancelled) setShelves(resolveShelves(indexBooks(all)));
    })();
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
  // A failed Get speaks up rather than silently flipping to "Retry" (FT-30).
  // One screen-level line; cleared the moment the reader tries again.
  const [getError, setGetError] = useState<string | null>(null);
  // After a genuinely-new book is saved we pause on a calm confirmation rather
  // than yanking the reader onward — the loop's intent is to return to Today and
  // build a plan, on the reader's click. A dedup needs no fanfare; it just hands
  // straight back so the existing book becomes active.
  const [saved, setSaved] = useState<{ outcome: ImportOutcome; title: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  function getBook(b: DiscoverBook) {
    const st = dl[b.id];
    if (st === "loading" || st === "done") return;
    if (!b.has_txt && !b.has_epub) return; // nothing importable
    setGetError(null); // clear any prior failure as the reader tries again
    setDl((m) => ({ ...m, [b.id]: "loading" }));
    invoke<ImportOutcome>("cmd_import_from_gutendex", {
      book: { txt_url: b.txt_url, epub_url: b.epub_url },
    })
      .then((outcome) => {
        setDl((m) => ({ ...m, [b.id]: "done" }));
        // New book → pause on the "Saved." confirmation; let the reader return
        // to Today (where the plan gets built). A dedup hands straight back.
        if (outcome.created) {
          setSaved({ outcome, title: b.title });
        } else {
          onPicked(outcome);
        }
      })
      .catch((e) => {
        // Calm, reversible: drop back so the row can be retried — and say what
        // happened, never just a silent flip to "Retry" (FT-30). Prefer the
        // backend's reason when it has one; otherwise a plain what-to-do line.
        const why = errorMessage(e);
        setGetError(
          why && why !== "(no error)"
            ? `Couldn’t download “${b.title}” — ${why} Check your connection, then try again.`
            : `Couldn’t download “${b.title}” — check your connection, then try again.`,
        );
        setDl((m) => ({ ...m, [b.id]: "error" }));
      });
  }

  const searching = d.query.trim().length > 0;

  // A book just landed in the library — calm hand-off back to Today, on a click.
  if (saved) {
    return (
      <div className="tl-body">
        <div className="tl-col tl-discover">
          <div className="tl-disc-saved" role="status">
            <span className="ico"><TLIcon name="check" size={30} /></span>
            <span className="big">Saved to your library</span>
            <span className="title">{saved.title}</span>
            <span>Build today’s plan, and you’ll have a section waiting whenever you sit down.</span>
            <div className="tl-disc-saved-actions">
              <button className="tl-btn tl-btn-primary" onClick={() => onPicked(saved.outcome)}>
                Open Today <TLIcon name="arrowRight" size={16} />
              </button>
              <button className="tl-btn tl-btn-ghost" onClick={() => setSaved(null)}>
                Find another
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tl-body">
      <div className="tl-col tl-discover">
        <button className="tl-disc-back" onClick={onBack}>
          <TLIcon name="chevronLeft" size={18} /> Cancel
        </button>
        <div className="tl-kicker"><span className="dot" />Public domain · free forever</div>
        <h1 className="tl-disc-title">Choose a book worth staying with.</h1>
        <div className="tl-disc-sub">
          A few good doorways into the public-domain library. Search is still here when you know what you want.
        </div>

        <div className="tl-search">
          <TLIcon name="search" size={18} />
          <input
            ref={searchRef}
            value={d.query}
            // The whole catalogue is on-device — surface its real scale (FT-37).
            // Read live from the mounted empty-search count; never hardcoded.
            placeholder={d.catalogueSize > 0 ? `Search all ${fmtN(d.catalogueSize)} titles…` : "Search all titles and authors…"}
            aria-label="Search all titles and authors in the public-domain library"
            onChange={(e) => d.setQuery(e.target.value)}
          />
        </div>

        {/* A Get that failed speaks up here (FT-30) — above the shelves and
            results both, so it's visible wherever the reader clicked Get. */}
        {getError && (
          <p className="tl-disc-geterror" role="alert">{getError}</p>
        )}

        {/* ── Idle (no query): curated editorial shelves ── */}
        {!searching ? (
          shelves.length > 0 ? (
            <div className="tl-shelves">
              {shelves.map((shelf) => (
                <section className="tl-shelf" key={shelf.key} aria-label={shelf.title}>
                  <div className="tl-shelf-h">
                    <h2 className="tl-shelf-title">{shelf.title}</h2>
                    <p className="tl-shelf-desc">{shelf.description}</p>
                  </div>
                  <div className="tl-shelf-cards">
                    {shelf.items.map(({ book, reason }) => {
                      const st = dl[book.id] ?? "idle";
                      const importable = book.has_txt || book.has_epub;
                      return (
                        <article className="tl-shelf-card" key={book.id}>
                          <div className="tl-shelf-card-body">
                            <div className="t" title={book.title}>{book.title}</div>
                            <div className="a">{book.author || "Unknown author"}</div>
                            <p className="why">{reason}</p>
                          </div>
                          <div className="tl-shelf-card-foot">
                            <button
                              className={"tl-getbtn" + (st === "loading" ? " loading" : st === "done" ? " done" : "")}
                              onClick={() => getBook(book)}
                              disabled={!importable || st === "loading" || st === "done"}
                              aria-label={
                                st === "done"
                                  ? `In library: ${book.title}`
                                  : importable
                                    ? `Get ${book.title}`
                                    : `${book.title} has no importable format`
                              }
                            >
                              {st === "done" ? (
                                <><TLIcon name="check" size={14} /> In library</>
                              ) : st === "loading" ? (
                                <><span className="tl-spin" /> Saving</>
                              ) : st === "error" ? (
                                <><TLIcon name="refresh" size={14} /> Retry</>
                              ) : importable ? (
                                <><TLIcon name="download" size={14} /> Get</>
                              ) : (
                                "—"
                              )}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="tl-disc-empty">
              <span className="ico"><TLIcon name="book" size={30} /></span>
              <span>Gathering the shelves…</span>
            </div>
          )
        ) : (
          /* ── Active query: the ranked on-device catalogue results list ── */
          <>
            <div className="tl-disc-meta" aria-live="polite">
              <span className="tl-disc-count">
                {d.status === "error" ? (
                  "Couldn’t search the library"
                ) : (
                  <>
                    <b>{fmtN(d.count)}</b> result{d.count === 1 ? "" : "s"} for “{d.query.trim()}”
                  </>
                )}
              </span>
            </div>

            {d.status === "error" ? (
              <div className="tl-disc-empty" role="alert">
                <span className="ico"><TLIcon name="search" size={30} /></span>
                <span className="big">Something went wrong searching</span>
                <span>Your imported books aren’t affected. Try the search again.</span>
                <button className="searchall" onClick={() => d.runSearch(d.query)}>
                  <TLIcon name="refresh" size={15} /> Try again
                </button>
              </div>
            ) : d.status === "loading" && d.results.length === 0 ? (
              <div className="tl-disc-empty">
                <span className="ico"><TLIcon name="search" size={30} /></span>
                <span>Searching the library…</span>
              </div>
            ) : d.results.length === 0 ? (
              // The whole on-device catalogue was searched, so a zero-result is
              // truthful absence — say so plainly and point to the next try.
              <div className="tl-disc-empty">
                <span className="ico"><TLIcon name="search" size={30} /></span>
                <span className="big">No match in the public-domain library</span>
                <span>Nothing for “{d.query.trim()}” — try another title or author.</span>
                <button className="searchall" onClick={() => d.setQuery("")}>
                  <TLIcon name="chevronLeft" size={15} /> Back to the shelves
                </button>
              </div>
            ) : (
              <>
                <div className="tl-index">
                  <div className="tl-index-h">
                    <span style={{ textAlign: "right" }}>#</span>
                    <span>Title</span>
                    <span style={{ paddingRight: 4 }}>Downloads</span>
                  </div>
                  {d.results.map((b, i) => {
                    const st = dl[b.id] ?? "idle";
                    const importable = b.has_txt || b.has_epub;
                    return (
                      <div className="tl-irow" key={b.id}>
                        <span className="rnk">{i + 1}</span>
                        <span className="tw">
                          <div className="it" title={b.title}>{b.title}</div>
                          <div className="ia">{b.author || "Unknown author"}</div>
                        </span>
                        <span className="meta">
                          <span className="dls">
                            <TLIcon name="arrowDown" size={13} /> {fmtN(b.download_count)}
                          </span>
                          {b.language && <span className="lang">{b.language.toUpperCase()}</span>}
                          <button
                            className={"tl-getbtn" + (st === "loading" ? " loading" : st === "done" ? " done" : "")}
                            onClick={() => getBook(b)}
                            disabled={!importable || st === "loading" || st === "done"}
                            aria-label={
                              st === "done"
                                ? `In library: ${b.title}`
                                : importable
                                  ? `Get ${b.title}`
                                  : `${b.title} has no importable format`
                            }
                          >
                            {st === "done" ? (
                              <><TLIcon name="check" size={14} /> In library</>
                            ) : st === "loading" ? (
                              <><span className="tl-spin" /> Saving</>
                            ) : st === "error" ? (
                              <><TLIcon name="refresh" size={14} /> Retry</>
                            ) : importable ? (
                              <><TLIcon name="download" size={14} /> Get</>
                            ) : (
                              "—"
                            )}
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>

                {d.nextPage != null && (
                  <div className="tl-disc-more">
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
  );
}

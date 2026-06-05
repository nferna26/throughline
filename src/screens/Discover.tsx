import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import { errorMessage, type DiscoverBook, type DiscoverPage, type ImportOutcome } from "../types";
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

// ── server-backed catalogue search ──
// Idle (empty query) shows the most-downloaded titles. Typing runs a debounced
// full-catalogue search. "Load more" appends the next page in place.
interface DiscoverState {
  query: string;
  results: DiscoverBook[];
  count: number;
  nextPage: number | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  offline: boolean;
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
    offline: false,
  });
  // Guards against out-of-order responses when the query changes mid-flight.
  const reqId = useRef(0);
  // Tracks which request's live result has already landed, so the (faster)
  // instant-seed paint never overwrites fresher live results.
  const liveDone = useRef(0);

  const runSearch = useCallback((q: string) => {
    const id = ++reqId.current;
    const trimmed = q.trim() || null;
    // Only show the bare spinner when we have nothing to keep on screen; an
    // existing list stays put until the next results replace it.
    setS((prev) => ({ ...prev, query: q, error: null, status: prev.results.length ? prev.status : "loading" }));

    // Phase 1 — instant offline seed (no network). Paints in milliseconds so
    // opening Discover never waits on the live API. For a query with no seed
    // match, stay in "loading" rather than flashing "no matches" before live.
    invoke<DiscoverPage>("cmd_discover_seed", { query: trimmed, page: 1 })
      .then((seed) => {
        if (id !== reqId.current || liveDone.current === id) return;
        if (!trimmed || seed.results.length > 0) {
          setS({
            query: q,
            results: seed.results,
            count: seed.count,
            nextPage: seed.next_page,
            status: "ready",
            loadingMore: false,
            error: null,
            offline: true,
          });
        } else {
          setS((prev) => ({ ...prev, query: q, status: "loading", error: null }));
        }
      })
      .catch(() => {/* the bundled seed never fails; ignore */});

    // Phase 2 — live catalogue (network; itself falls back to the seed on
    // failure). Replaces the seed paint when it lands: full catalogue if the API
    // answered, or the same seed (invisibly) if it was unreachable.
    invoke<DiscoverPage>("cmd_discover_search", { query: trimmed, page: 1 })
      .then((page) => {
        if (id !== reqId.current) return;
        liveDone.current = id;
        setS({
          query: q,
          results: page.results,
          count: page.count,
          nextPage: page.next_page,
          status: "ready",
          loadingMore: false,
          error: null,
          offline: page.offline,
        });
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        liveDone.current = id;
        // Keep the seed if it already painted; only surface an error if nothing did.
        setS((prev) => (prev.status === "ready" ? prev : { ...prev, status: "error", error: errorMessage(e) }));
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
      // When showing the offline seed, page it instantly from the seed too;
      // only reach for the (slow when down) live API once we're on live results.
      const cmd = prev.offline ? "cmd_discover_seed" : "cmd_discover_search";
      invoke<DiscoverPage>(cmd, { query: prev.query.trim() || null, page })
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
    offline: s.offline,
    runSearch,
    loadMore,
  };
}

export default function Discover({ onBack, onPicked }: Props) {
  const d = useDiscover();
  const [dl, setDl] = useState<Record<number, DlState>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  function getBook(b: DiscoverBook) {
    const st = dl[b.id];
    if (st === "loading" || st === "done") return;
    if (!b.has_txt && !b.has_epub) return; // nothing importable
    setDl((m) => ({ ...m, [b.id]: "loading" }));
    invoke<ImportOutcome>("cmd_import_from_gutendex", {
      book: { txt_url: b.txt_url, epub_url: b.epub_url },
    })
      .then((outcome) => {
        setDl((m) => ({ ...m, [b.id]: "done" }));
        onPicked(outcome);
      })
      .catch(() => {
        // Calm, reversible: drop back so the row can be retried.
        setDl((m) => ({ ...m, [b.id]: "error" }));
      });
  }

  const searching = d.query.trim().length > 0;

  return (
    <div className="tl-body">
      <div className="tl-col tl-discover">
        <button className="tl-disc-back" onClick={onBack}>
          <TLIcon name="chevronLeft" size={18} /> Cancel
        </button>
        <div className="tl-kicker"><span className="dot" />Public domain · free forever</div>
        <h1 className="tl-disc-title">Discover a book</h1>
        <div className="tl-disc-sub">
          {d.count > 0 && !d.offline ? `${fmtN(d.count)} free titles · ` : ""}saved straight to this Mac
        </div>

        <div className="tl-search">
          <TLIcon name="search" size={18} />
          <input
            ref={searchRef}
            value={d.query}
            placeholder="Search the catalogue by title or author…"
            aria-label="Search the public-domain library by title or author"
            onChange={(e) => d.setQuery(e.target.value)}
          />
        </div>

        <div className="tl-disc-meta" aria-live="polite">
          <span className="tl-disc-count">
            {d.status === "error" ? (
              "Couldn't reach the library"
            ) : searching ? (
              <>
                <b>{fmtN(d.count)}</b> result{d.count === 1 ? "" : "s"} for “{d.query.trim()}”
              </>
            ) : (
              "Most downloaded"
            )}
          </span>
          {d.offline && d.status !== "error" && (
            <span className="tl-disc-offline" title="The live library was unreachable — showing a built-in catalogue of popular titles.">
              <TLIcon name="globe" size={13} /> Offline catalogue
            </span>
          )}
        </div>

        {d.status === "error" ? (
          <div className="tl-disc-empty" role="alert">
            <span className="ico"><TLIcon name="globe" size={30} /></span>
            <span className="big">The public-domain library isn’t responding</span>
            <span>It may be briefly unavailable, or you might be offline. Your imported books aren’t affected — only finding new ones needs the connection.</span>
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
          <div className="tl-disc-empty">
            <span className="ico"><TLIcon name="search" size={30} /></span>
            <span className="big">No matches</span>
            <span>“{d.query.trim()}” isn’t in the public-domain library.</span>
            <button className="searchall" onClick={() => d.setQuery("")}>
              <TLIcon name="arrowDown" size={15} /> Browse the most downloaded
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
      </div>
    </div>
  );
}

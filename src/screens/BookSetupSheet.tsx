import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Cover from "../components/Cover";
import type { Book } from "../types";
import { errorMessage } from "../types";
import "./BookSetupSheet.css";

interface Props {
  book: Book;
  /** Proceed once the pace is set. `begin` = go straight into the first sitting
   *  ("Start reading"); false = land on Today ("I'll decide as I go", or a
   *  returning reader who already set a pace and skips this step). */
  onDone: (begin: boolean) => void;
}

/** The one added question, in reading terms — NEVER minutes. The three map
 *  internally to the brief's 10 / 25 / 60-minute pacing, but that mapping is the
 *  backstage `minutes` value here and is never shown to the reader. */
const PACES = [
  { minutes: 10, name: "A few pages", desc: "a small, easy daily portion" },
  { minutes: 25, name: "A chapter", desc: "a satisfying single sitting" },
  { minutes: 60, name: "A long read", desc: "settle in for a good while" },
] as const;
/** "A chapter" is the sensible default — pre-selected, and the value the skip
 *  link commits. */
const DEFAULT_PACE = 25;

/** The reading-pace option glyphs (a page, an open book, two volumes) + the
 *  selection check. Authored inline so the screen carries the handoff's exact
 *  icons without a new dependency. */
function PaceIcon({ minutes }: { minutes: number }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (minutes <= 10) {
    return (
      <svg {...common}>
        <path d="M6 4h9l3 3v13H6z" />
        <path d="M9 9h6M9 12h6M9 15h4" />
      </svg>
    );
  }
  if (minutes >= 60) {
    return (
      <svg {...common}>
        <path d="M3 5h7v15H3zM14 5h7v15h-7z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5" />
    </svg>
  );
}

/**
 * The book you chose → your reading pace, as one continuous beat. The cover you
 * picked rises to centre and becomes the thing waiting on Today (the same cloth
 * object, carried forward); then the one calm question sizes each day's reading,
 * in reading terms, never a timer.
 *
 * A returning reader who already set a pace skips the question entirely: this
 * book's plan is configured with the saved pace and they land straight on Today.
 * Pace persists globally (Settings owns the change-it-anytime control) AND on the
 * book's plan (cmd_configure_plan) — the existing per-book pacing the engine reads.
 */
export default function BookSetupSheet({ book, onDone }: Props) {
  // false until we know whether to show the pace step — avoids a flash of the
  // question for a returning reader who skips it.
  const [ready, setReady] = useState(false);
  const [pace, setPace] = useState<number>(DEFAULT_PACE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<{ minutes: number; chosen: boolean }>("cmd_get_reading_pace")
      .then(async (p) => {
        if (cancelled) return;
        if (p.chosen) {
          // Returning reader: configure this book with the saved pace and go
          // straight to Today, skipping the question entirely.
          try {
            await invoke("cmd_configure_plan", {
              bookId: book.id,
              sittingLengthMinutes: p.minutes,
              name: null,
            });
          } catch {
            /* a configure failure still lands on Today; the plan falls back to
               the default sitting. Better calm than stranded. */
          }
          onDone(false);
          return;
        }
        // First time: ask. Default to "A chapter".
        setPace(DEFAULT_PACE);
        setReady(true);
      })
      .catch(() => {
        // Couldn't read the pace — ask rather than silently skip.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
    // book.id is stable for this sheet's lifetime; onDone is a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // Commit the pace and proceed. `persist` writes the GLOBAL preference (so future
  // books default to it and the step is skipped next time) AND marks it chosen;
  // the skip link does NOT persist (the reader hasn't settled on a pace). Either
  // path configures THIS book's plan so Today is sized.
  async function commit(begin: boolean, minutes: number, persist: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      if (persist) await invoke("cmd_set_reading_pace", { minutes });
      await invoke("cmd_configure_plan", {
        bookId: book.id,
        sittingLengthMinutes: minutes,
        name: null,
      });
      onDone(begin);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  // Roving radio focus: arrows move the selection (WAI-ARIA radio pattern).
  function onCardKey(e: React.KeyboardEvent, idx: number) {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % PACES.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx + PACES.length - 1) % PACES.length;
    if (next == null) return;
    e.preventDefault();
    setPace(PACES[next].minutes);
    cardRefs.current[next]?.focus();
  }

  if (!ready) {
    // Brief, contentless — the pace check is a fast local read.
    return <div className="tl-journey-screen" aria-busy="true" />;
  }

  return (
    <div className="tl-journey-screen">
      <div className="tl-journey-scroll">
        {/* ── The book you chose (the cover rises to centre) ── */}
        <div className="tl-chosen">
          <Cover title={book.title} author={book.author} size="full" />
          <p className="tl-chosen-eyebrow">Added to Today</p>
          <h1 className="tl-chosen-h">{book.title} is yours to begin.</h1>
          <p className="tl-chosen-line">
            It's waiting on Today now. One last thing before you start: how do you like to read?
          </p>
        </div>

        {/* ── Your reading pace ── */}
        <div className="tl-pace">
          <p className="tl-pace-eyebrow">How you like to read</p>
          <h2 className="tl-pace-q">What feels like a good sitting?</h2>
          <p className="tl-pace-sub">
            This just sizes each day's reading. There's no timer, and you can change it anytime.
          </p>

          <div className="tl-pace-opts" role="radiogroup" aria-label="What feels like a good sitting?">
            {PACES.map((p, i) => {
              const on = p.minutes === pace;
              return (
                <button
                  type="button"
                  key={p.minutes}
                  ref={(el) => {
                    cardRefs.current[i] = el;
                  }}
                  className={on ? "tl-pace-opt on" : "tl-pace-opt"}
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setPace(p.minutes)}
                  onKeyDown={(e) => onCardKey(e, i)}
                >
                  <span className="tl-pace-ico">
                    <PaceIcon minutes={p.minutes} />
                  </span>
                  <span className="tl-pace-name">{p.name}</span>
                  <span className="tl-pace-desc">{p.desc}</span>
                  <svg
                    className="tl-pace-check"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M16.5 6.5L8.5 14.5 4 10" />
                  </svg>
                </button>
              );
            })}
          </div>

          {error && (
            <p className="tl-warn-text" role="alert" style={{ marginTop: "var(--tl-3)" }}>
              Couldn't save your pace: {error}
            </p>
          )}

          <div className="tl-pace-actions">
            <button
              type="button"
              className="tl-btn tl-btn-primary"
              disabled={submitting}
              onClick={() => commit(true, pace, true)}
            >
              Start reading
            </button>
            <button
              type="button"
              className="tl-pace-skip"
              disabled={submitting}
              onClick={() => commit(false, DEFAULT_PACE, false)}
            >
              I'll decide as I go
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import type { TodayCard, Book, PlanSummary } from "../types";
import { splitDisplayTitle } from "../displayTitle";

interface Props {
  today: TodayCard | null;
  /** Open the public-domain catalogue (the "find another book" path). */
  onDiscover: () => void;
  /** Import a local .txt/.epub (the post-finish "Import a file" secondary). */
  onImport?: () => void;
  /** Open the reader at the current sitting. */
  onStart: (t: TodayCard) => void;
  /** Create a fresh plan for the book (the plan-less "Start a plan" flow). */
  onNewPlan?: (book: Book) => void;
  /** Jump to the Notes tab (the finished-book "Review your notes" action). */
  onReviewNotes?: () => void;
  /** Open the manage-plans view (the quiet "earlier attempts" link). */
  onPlans?: () => void;
}

// Time-of-day greeting in the app's quiet voice. The kicker is the only place the
// hour shows up; everything else is timeless.
function timeOfDay(): string {
  const h = new Date().getHours();
  if (h < 12) return "This morning";
  if (h < 18) return "This afternoon";
  return "This evening";
}

const SMALL = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];
// "about eight minutes" reads calmer than "about 8 min". Spell out small counts;
// fall back to digits past twenty (rare for a single sitting).
function minutesPhrase(n: number): string {
  const word = n >= 0 && n <= 20 ? SMALL[n] : String(n);
  return `About ${word} minute${n === 1 ? "" : "s"}.`;
}

/** A subtle, dismissible post-finish nudge: after a book is finished, gently
 *  offer the next one. Never a nag — once "Not now" is chosen for this book it
 *  stays dismissed (persisted per book), and there is no streak or upsell tone. */
function FinishAddPrompt({
  bookId,
  onDiscover,
  onImport,
}: {
  bookId: string;
  onDiscover: () => void;
  onImport?: () => void;
}) {
  const key = `tl.finishAddDismissed.${bookId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="tl-finish-add" role="group" aria-label="Add another book">
      <p className="tl-finish-add-q">Want to add another book?</p>
      <div className="tl-finish-add-actions">
        <button className="tl-link-quiet" onClick={onDiscover}>Find another book</button>
        {onImport && <button className="tl-link-quiet" onClick={onImport}>Import a file</button>}
        <button
          className="tl-finish-add-dismiss"
          onClick={() => {
            try {
              localStorage.setItem(key, "1");
            } catch {
              /* ignore */
            }
            setDismissed(true);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/** The book title as the bounded serif hero. EPUB titles are unbounded and messy,
 *  so the big headline shows the main part (split on the first colon only — never
 *  comma/paren), capped by clamp() + line-clamp in CSS, with any subtitle below in
 *  a quieter line. The FULL stored title is always kept for hover (title=) and for
 *  screen readers (the heading's aria-label) — the visual clamp never hides info
 *  from assistive tech. */
function HeroTitle({ title }: { title: string }) {
  const { main, subtitle } = splitDisplayTitle(title);
  // aria-label carries the FULL stored title to assistive tech (the visible text
  // is the clamped main part); title= is the hover tooltip. The visual clamp
  // never hides information from AT.
  return (
    <>
      <h1
        className={subtitle ? "tl-desk-title has-sub" : "tl-desk-title"}
        title={title}
        aria-label={title}
      >
        {main}
      </h1>
      {subtitle && (
        <p className="tl-desk-subtitle" aria-hidden="true">
          {subtitle}
        </p>
      )}
    </>
  );
}

export default function Today({ today, onDiscover, onImport, onStart, onNewPlan, onReviewNotes, onPlans }: Props) {
  const bookId = today?.book.id;
  // How many plans this book has — drives the quiet "Plans · N earlier" link.
  const [plansCount, setPlansCount] = useState(0);
  useEffect(() => {
    if (!bookId) {
      setPlansCount(0);
      return;
    }
    invoke<PlanSummary[]>("cmd_list_plans_for_book", { bookId })
      .then((p) => setPlansCount(Array.isArray(p) ? p.length : 0))
      .catch(() => setPlansCount(0));
  }, [bookId]);

  // First-run (no book yet) is owned by the front door now — App routes
  // today === null → FrontDoor, so Today never renders the empty state itself.
  if (!today) return null;

  const { book, state, chapter_label, phrase, estimated_minutes, fraction_complete, next_label } = today;

  // ── Every plan let go: the book still owns Today ─────────────────────────
  if (state === "no_plan") {
    return (
      <div className="tl-desk">
        <p className="tl-desk-kicker">On your desk</p>
        <HeroTitle title={book.title} />
        {book.author && <p className="tl-desk-author">{book.author}</p>}
        <div className="tl-hairline" aria-hidden="true"><span className="fill" style={{ width: 0 }} /></div>
        <p className="tl-desk-orient">There's no plan right now. Set a gentle pace whenever you're ready.</p>
        <button className="tl-btn tl-btn-primary tl-desk-cta" onClick={() => onNewPlan?.(book)}>Start a plan</button>
      </div>
    );
  }

  // ── Finished the book ────────────────────────────────────────────────────
  if (state === "finished") {
    return (
      <div className="tl-desk">
        <span className="tl-check-ring" aria-hidden="true"><TLIcon name="check" size={20} /></span>
        <h1 className="tl-desk-done" title={book.title} aria-label={`You finished ${book.title}.`}>
          You finished {splitDisplayTitle(book.title).main}.
        </h1>
        <p className="tl-desk-orient">
          Nicely done.{next_label ? ` ${next_label} was the last of it.` : ""} Sit with it, or pick up something new.
        </p>
        <div className="tl-desk-finish-actions">
          {onReviewNotes && (
            <button className="tl-btn tl-btn-ghost" onClick={onReviewNotes}>Review your notes</button>
          )}
        </div>
        <FinishAddPrompt bookId={book.id} onDiscover={onDiscover} onImport={onImport} />
      </div>
    );
  }

  // ── day_one / reading / returning — the book on the desk ─────────────────
  const dayOne = state === "day_one";
  const returning = state === "returning";
  const kicker = dayOne ? "Beginning today" : returning ? "Welcome back" : timeOfDay();
  // The phrase slot is ALWAYS rendered (the label carries it now; Stage 3's phrase
  // is a pure text swap into the same reserved two-line slot, zero layout shift).
  const phraseLine = phrase ? `${chapter_label}, ${phrase}` : chapter_label;
  const button = dayOne ? "Begin reading" : "Continue reading";

  return (
    <div className="tl-desk">
      <p className="tl-desk-kicker">{kicker}</p>
      <HeroTitle title={book.title} />
      {book.author && <p className="tl-desk-author">{book.author}</p>}

      <div className="tl-hairline" aria-hidden="true">
        <span className="fill" style={{ width: dayOne ? 0 : `${Math.max(0, Math.min(1, fraction_complete)) * 100}%` }} />
      </div>

      <div className="tl-desk-orient">
        {dayOne ? (
          // The first-journey lands here: the portion reads qualitatively, at the
          // pace the reader set, never a count or a clock.
          <p className="line where">The first chapter, at the pace you set. No clock but your own.</p>
        ) : returning ? (
          <>
            <p className="line plain">The story kept your place.</p>
            <p className="line phrase">{chapter_label} is waiting where you left it.</p>
          </>
        ) : (
          <>
            <p className="line phrase">{phraseLine}</p>
            <p className="line plain">{minutesPhrase(estimated_minutes)}</p>
          </>
        )}
      </div>

      <button className="tl-btn tl-btn-primary tl-desk-cta" disabled={!today.section} onClick={() => onStart(today)}>
        {button}
      </button>

      {plansCount > 1 && (
        <button className="tl-link-quiet tl-desk-plans" onClick={() => onPlans?.()} aria-label="Earlier attempts at this book">
          {plansCount - 1} earlier attempt{plansCount - 1 === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

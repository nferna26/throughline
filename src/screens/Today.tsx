import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import type { TodayCard, Book, PlanSummary } from "../types";

interface Props {
  today: TodayCard | null;
  /** Open the public-domain catalogue (the primary "get a book" path). */
  onDiscover: () => void;
  /** Import a local .txt/.epub via the file picker (the secondary path). */
  onImport: () => void;
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

  // ── First run: no book yet ──────────────────────────────────────────────
  if (!today) {
    return (
      <div className="tl-welcome">
        <div className="tl-welcome-card">
          <div className="mark"><TLIcon name="book" size={26} /></div>
          <h1>Welcome to Throughline</h1>
          <p>One book at a time, a little each day. Find something you mean to finish, and it'll be waiting on Today.</p>
          <ul className="tl-welcome-promise" aria-label="How Throughline treats your reading">
            <li><TLIcon name="check" size={15} /> Your books stay on this Mac. If you ask the tutor, only the passage you select is sent, never the book.</li>
            <li><TLIcon name="check" size={15} /> Your notes export as plain Markdown that outlives the app.</li>
            <li><TLIcon name="check" size={15} /> No account, no cloud, no tracking.</li>
          </ul>
          <button className="tl-btn tl-btn-primary" style={{ margin: "0 auto" }} onClick={onDiscover}>
            <TLIcon name="search" size={18} /> Find a book to read
          </button>
          <button className="tl-btn-quiet" style={{ margin: "var(--tl-2) auto 0" }} onClick={onImport}>
            <TLIcon name="upload" size={16} /> Import a file instead
          </button>
          <div className="hint">Thousands of free public-domain books · or your own .txt / .epub · stays on this Mac</div>
        </div>
      </div>
    );
  }

  const { book, state, chapter_label, phrase, estimated_minutes, fraction_complete, next_label } = today;

  // ── Every plan let go: the book still owns Today ─────────────────────────
  if (state === "no_plan") {
    return (
      <div className="tl-desk">
        <p className="tl-desk-kicker">On your desk</p>
        <h1 className="tl-desk-title">{book.title}</h1>
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
        <h1 className="tl-desk-done">You finished {book.title}.</h1>
        <p className="tl-desk-orient">
          Nicely done.{next_label ? ` ${next_label} was the last of it.` : ""} Sit with it, or pick up something new.
        </p>
        <div className="tl-desk-finish-actions">
          {onReviewNotes && (
            <button className="tl-btn tl-btn-ghost" onClick={onReviewNotes}>Review your notes</button>
          )}
          <button className="tl-link-quiet" onClick={onDiscover}>Find another book</button>
        </div>
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
      <h1 className="tl-desk-title">{book.title}</h1>
      {book.author && <p className="tl-desk-author">{book.author}</p>}

      <div className="tl-hairline" aria-hidden="true">
        <span className="fill" style={{ width: dayOne ? 0 : `${Math.max(0, Math.min(1, fraction_complete)) * 100}%` }} />
      </div>

      <div className="tl-desk-orient">
        {dayOne ? (
          <>
            <p className="line plain">We've set an unhurried pace.</p>
            <p className="line plain">There's no clock but your own.</p>
          </>
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

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Book, BookSection } from "../types";
import { errorMessage } from "../types";

interface Props {
  book: Book;
  /** Proceed once the plan is configured. `begin` = go straight into the first
   *  sitting ("Begin reading"); false = land on Today ("I'll decide as I go"). */
  onDone: (begin: boolean) => void;
}

// Reading-speed midpoint for the length line and the horizon sentence. The
// numbers stay backstage: everything the reader sees is plain words.
const WPM_MID = 200;
const CHARS_PER_WORD = 5;

// The one question's three answers. Names are reused VERBATIM in the horizon
// sentence, so they must read naturally after "At …".
const SITTINGS = [
  { minutes: 10, name: "A few pages", sub: "about ten minutes" },
  { minutes: 25, name: "A steady sitting", sub: "about twenty-five" },
  { minutes: 60, name: "A long read", sub: "about an hour" },
] as const;
const DEFAULT_SITTING = 25;

const SMALL = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];
const TENS = ["", "ten", "twenty", "thirty", "forty", "fifty"];

/** Whole-book length in plain words ("about two hours of reading") — never
 *  decimals, never numerals-as-data. Exported for tests. */
export function lengthPhrase(totalMinutes: number): string {
  if (totalMinutes < 8) return "a few minutes of reading";
  if (totalMinutes < 55) {
    const tens = Math.min(5, Math.max(1, Math.round(totalMinutes / 10)));
    return `about ${TENS[tens]} minutes of reading`;
  }
  if (totalMinutes < 90) return "about an hour of reading";
  const h = Math.round(totalMinutes / 60);
  const word = h <= 20 ? SMALL[h] : String(h);
  return `about ${word} hours of reading`;
}

/** The horizon sentence: the chosen card's name verbatim, qualitative cadence,
 *  always "around early/mid/late {month}", conditional mood. Null when the
 *  book's length is unknown — better silent than invented. Exported for tests. */
export function horizonSentence(name: string, totalMinutes: number | null, sittingMinutes: number): string | null {
  if (!totalMinutes || totalMinutes <= 0 || sittingMinutes <= 0) return null;
  const days = Math.max(1, Math.ceil(totalMinutes / sittingMinutes));
  const finish = new Date();
  finish.setHours(0, 0, 0, 0);
  finish.setDate(finish.getDate() + days);
  const d = finish.getDate();
  const bucket = d <= 10 ? "early" : d <= 20 ? "mid" : "late";
  const month = finish.toLocaleString("en-US", { month: "long" });
  const nextYear = finish.getFullYear() > new Date().getFullYear();
  const when = nextYear ? `${bucket} ${month} next year` : `${bucket} ${month}`;
  const cardName = name.charAt(0).toLowerCase() + name.slice(1);
  return `At ${cardName} most evenings, you'd finish around ${when}.`;
}

/**
 * The plan screen, shown once right after a book arrives: one question (how
 * much feels right at a sitting?), three quiet cards, one primary action.
 * No finish date, no days-a-week, no margin help (that lives in Settings),
 * no plan name — the plan paces and silently re-paces itself forever after.
 */
export default function BookSetupSheet({ book, onDone }: Props) {
  const [sections, setSections] = useState<BookSection[]>([]);
  const [sitting, setSitting] = useState<number>(DEFAULT_SITTING);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<BookSection[]>("cmd_assignable_sections", { bookId: book.id })
      .then((list) => { if (!cancelled) setSections(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setSections([]); });
    return () => { cancelled = true; };
  }, [book.id]);

  // Whole-book minutes from captured per-section lengths (estimated_units is
  // the same char unit for txt and epub). Unknown → the length line and the
  // horizon simply stay silent.
  const totalMinutes = useMemo(() => {
    const chars = sections.reduce((sum, s) => sum + (s.estimated_units ?? 0), 0);
    if (chars <= 0) return null;
    return chars / CHARS_PER_WORD / WPM_MID;
  }, [sections]);

  const selected = SITTINGS.find((s) => s.minutes === sitting) ?? SITTINGS[1];
  const horizon = horizonSentence(selected.name, totalMinutes, sitting);
  const metaParts = [
    book.author,
    totalMinutes != null ? lengthPhrase(totalMinutes) : null,
  ].filter(Boolean);

  // Configure the book's current plan and proceed. The question never blocks:
  // the quiet link confirms with the default sitting and moves on.
  async function confirm(begin: boolean, minutes: number) {
    setSubmitting(true);
    setError(null);
    try {
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
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % SITTINGS.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx + SITTINGS.length - 1) % SITTINGS.length;
    if (next == null) return;
    e.preventDefault();
    setSitting(SITTINGS[next].minutes);
    cardRefs.current[next]?.focus();
  }

  return (
    <div className="tl-plan-screen">
      <div className="tl-plan-scroll">
        <div className="tl-plan-col">
          <div className="tl-kicker"><span className="dot" />New on your desk</div>
          <h1 className="tl-plan-title">{book.title}</h1>
          {metaParts.length > 0 && <p className="tl-plan-meta">{metaParts.join(" · ")}</p>}

          <p className="tl-q-prompt">How much feels right at a sitting?</p>

          <div className="tl-q-cards" role="radiogroup" aria-label="How much feels right at a sitting?">
            {SITTINGS.map((s, i) => {
              const on = s.minutes === sitting;
              return (
                <button
                  type="button"
                  key={s.minutes}
                  ref={(el) => { cardRefs.current[i] = el; }}
                  className={on ? "tl-q-card on" : "tl-q-card"}
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setSitting(s.minutes)}
                  onKeyDown={(e) => onCardKey(e, i)}
                >
                  <span className="tl-qc-name">{s.name}</span>
                  <span className="tl-qc-sub">{s.sub}</span>
                  <span className="tl-qc-dot" aria-hidden="true" />
                </button>
              );
            })}
          </div>

          {/* Updates with the selection; describes, never commits. */}
          <p className="tl-plan-horizon" aria-live="polite">{horizon}</p>

          {error && <p className="tl-warn-text" role="alert">Couldn't save the plan: {error}</p>}

          <div className="tl-plan-actions">
            <button className="tl-btn tl-btn-primary" disabled={submitting} onClick={() => confirm(true, sitting)}>
              Begin reading
            </button>
            <button className="tl-link-quiet" disabled={submitting} onClick={() => confirm(false, DEFAULT_SITTING)}>
              I'll decide as I go
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

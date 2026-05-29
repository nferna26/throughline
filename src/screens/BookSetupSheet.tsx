import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RGIcon from "../components/RGIcon";
import type { Book, BookSection } from "../types";

interface Props {
  book: Book;
  /** Proceed to Today — called after the plan is configured OR deferred. */
  onDone: () => void;
}

type FinishMode = "week" | "month" | "date";

// Words-per-minute band the spec calls for. We decide feasibility on the
// midpoint and show the range as an honest "about X–Y" estimate.
const WPM_SLOW = 180;
const WPM_FAST = 220;
const WPM_MID = 200;
const CHARS_PER_WORD = 5;

const MINUTE_PRESETS = [15, 25, 45, 60];
const DAY_PRESETS = [3, 4, 5, 6, 7];

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}
function humanHours(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const h = minutes / 60;
  if (h < 10) return `${h.toFixed(1).replace(/\.0$/, "")} hours`;
  return `${Math.round(h)} hours`;
}

export default function BookSetupSheet({ book, onDone }: Props) {
  const [sections, setSections] = useState<BookSection[]>([]);
  const [finishMode, setFinishMode] = useState<FinishMode>("month");
  const [customDate, setCustomDate] = useState<string>(isoDate(addDays(30)));
  const [sessionMinutes, setSessionMinutes] = useState<number>(25);
  const [daysPerWeek, setDaysPerWeek] = useState<number>(5);
  const [marginHelp, setMarginHelp] = useState<"guided" | "quiet">("guided");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<BookSection[]>("cmd_assignable_sections", { bookId: book.id })
      .then((list) => { if (!cancelled) setSections(list); })
      .catch(() => { if (!cancelled) setSections([]); });
    return () => { cancelled = true; };
  }, [book.id]);

  const targetDate = useMemo(() => {
    if (finishMode === "week") return isoDate(addDays(7));
    if (finishMode === "month") return isoDate(addDays(30));
    return customDate;
  }, [finishMode, customDate]);

  // Length estimate from captured per-section lengths (estimated_units is the
  // same char unit for txt and epub). If we have no lengths, hide the estimate
  // rather than guess.
  const est = useMemo(() => {
    const totalChars = sections.reduce((sum, s) => sum + (s.estimated_units ?? 0), 0);
    if (totalChars <= 0) return null;
    const words = totalChars / CHARS_PER_WORD;
    const minsSlow = words / WPM_SLOW;
    const minsFast = words / WPM_FAST;
    const minsMid = words / WPM_MID;

    const today = addDays(0).getTime();
    const finish = new Date(targetDate + "T00:00:00").getTime();
    const daysUntil = Math.max(1, Math.round((finish - today) / 86_400_000) + 1);
    const sessionsAvail = Math.max(0, Math.floor((daysUntil * daysPerWeek) / 7));
    const capacityMin = sessionsAvail * sessionMinutes;
    const feasible = sessionsAvail > 0 && capacityMin >= minsMid;
    const neededPerSession = sessionsAvail > 0 ? Math.ceil(minsMid / sessionsAvail) : Math.ceil(minsMid);
    // Weeks to finish at the chosen rhythm: total minutes / weekly minutes.
    const weeklyMin = daysPerWeek * sessionMinutes;
    const weeks = Math.max(1, Math.ceil(minsMid / Math.max(1, weeklyMin)));

    return { minsSlow, minsFast, feasible, neededPerSession, weeks };
  }, [sections, targetDate, daysPerWeek, sessionMinutes]);

  async function startPlan() {
    setSubmitting(true);
    setError(null);
    try {
      await invoke("cmd_configure_plan", {
        bookId: book.id,
        targetFinishDate: targetDate,
        daysPerWeek,
        sessionMinutes,
        marginHelp,
      });
      onDone();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="rg-setup">
      <div className="rg-setup-card">
        <div className="rg-kicker"><span className="dot" />New book</div>
        <h1 className="rg-setup-title">{book.title}</h1>
        {book.author && <div className="rg-today-author">{book.author}</div>}
        <p className="rg-planready-note" style={{ marginTop: "var(--rg-4)" }}>
          Plan ready. You are not behind. Set a rhythm below, or decide later — your pace clock
          only starts when you begin reading.
        </p>

        <fieldset className="rg-setup-group">
          <legend>Finish rhythm</legend>
          <div className="rg-chips" role="radiogroup" aria-label="Finish rhythm">
            <button type="button" role="radio" aria-checked={finishMode === "week"} className={finishMode === "week" ? "rg-chip on" : "rg-chip"} onClick={() => setFinishMode("week")}>This week</button>
            <button type="button" role="radio" aria-checked={finishMode === "month"} className={finishMode === "month" ? "rg-chip on" : "rg-chip"} onClick={() => setFinishMode("month")}>This month</button>
            <button type="button" role="radio" aria-checked={finishMode === "date"} className={finishMode === "date" ? "rg-chip on" : "rg-chip"} onClick={() => setFinishMode("date")}>Pick a date</button>
          </div>
          {finishMode === "date" && (
            <input
              type="date"
              className="rg-input"
              style={{ marginTop: "var(--rg-3)", maxWidth: 200 }}
              value={customDate}
              min={isoDate(addDays(1))}
              onChange={(e) => setCustomDate(e.target.value)}
              aria-label="Target finish date"
            />
          )}
        </fieldset>

        <fieldset className="rg-setup-group">
          <legend>Reading rhythm</legend>
          <div className="rg-setup-row">
            <span className="rg-setup-label">Session length</span>
            <div className="rg-chips" role="radiogroup" aria-label="Session length in minutes">
              {MINUTE_PRESETS.map((m) => (
                <button type="button" key={m} role="radio" aria-checked={sessionMinutes === m} className={sessionMinutes === m ? "rg-chip on" : "rg-chip"} onClick={() => setSessionMinutes(m)}>{m} min</button>
              ))}
            </div>
          </div>
          <div className="rg-setup-row">
            <span className="rg-setup-label">Days per week</span>
            <div className="rg-chips" role="radiogroup" aria-label="Reading days per week">
              {DAY_PRESETS.map((d) => (
                <button type="button" key={d} role="radio" aria-checked={daysPerWeek === d} className={daysPerWeek === d ? "rg-chip on" : "rg-chip"} onClick={() => setDaysPerWeek(d)}>{d}</button>
              ))}
            </div>
          </div>
          <p className="rg-setup-hint">{daysPerWeek} reading days, {7 - daysPerWeek} to rest. No streak to break.</p>
        </fieldset>

        <fieldset className="rg-setup-group">
          <legend>Margin help</legend>
          <div className="rg-chips" role="radiogroup" aria-label="Margin help">
            <button type="button" role="radio" aria-checked={marginHelp === "guided"} className={marginHelp === "guided" ? "rg-chip on" : "rg-chip"} onClick={() => setMarginHelp("guided")}>Guided</button>
            <button type="button" role="radio" aria-checked={marginHelp === "quiet"} className={marginHelp === "quiet" ? "rg-chip on" : "rg-chip"} onClick={() => setMarginHelp("quiet")}>Quiet</button>
          </div>
          <p className="rg-setup-hint">
            {marginHelp === "guided"
              ? "Gentle prompts in the margin while you read."
              : "The margin stays out of the way until you ask."}
          </p>
        </fieldset>

        {est && (
          <div className={est.feasible ? "rg-setup-estimate" : "rg-setup-estimate tight"} role="note">
            <RGIcon name={est.feasible ? "clock" : "behind"} size={15} />
            <span>
              About {humanHours(est.minsFast)}–{humanHours(est.minsSlow)} of reading.{" "}
              {est.feasible
                ? `At ${sessionMinutes} min × ${daysPerWeek} days, that's roughly ${est.weeks} week${est.weeks === 1 ? "" : "s"} — comfortably before ${targetDate}.`
                : `Finishing by ${targetDate} would mean about ${est.neededPerSession} min per session. At this rhythm it's closer to ${est.weeks} week${est.weeks === 1 ? "" : "s"} — give it more time, longer sittings, or more days.`}
            </span>
          </div>
        )}

        {error && <p className="rg-warn-text" role="alert">Couldn't save the plan: {error}</p>}

        <div className="rg-setup-actions">
          <button className="rg-btn rg-btn-ghost" disabled={submitting} onClick={onDone}>Decide later</button>
          <button className="rg-btn rg-btn-primary" disabled={submitting} onClick={startPlan}>
            {submitting ? "Saving…" : "Start this plan"}
          </button>
        </div>
      </div>
    </div>
  );
}

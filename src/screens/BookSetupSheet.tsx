import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import type { Book, BookSection, PlanSummary } from "../types";

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

/** One unified segmented-pill control for every choice group (the design
 *  handoff's .tl-choice). Single-select, so it keeps radio semantics
 *  (role=radiogroup / aria-checked) for WCAG-AA, not the handoff's aria-pressed.
 *  Module-level so its identity is stable across renders (a nested definition
 *  would remount the subtree and strand element refs). */
function Choice<T extends string | number>(props: {
  label: string;
  value: T;
  set: (v: T) => void;
  options: Array<{ v: T; l: string }>;
  compact?: boolean;
}) {
  return (
    <div className={"tl-choice" + (props.compact ? " compact" : "")} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          type="button"
          key={String(o.v)}
          role="radio"
          aria-checked={props.value === o.v}
          onClick={() => props.set(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

export default function BookSetupSheet({ book, onDone }: Props) {
  const [sections, setSections] = useState<BookSection[]>([]);
  const [finishMode, setFinishMode] = useState<FinishMode>("month");
  const [customDate, setCustomDate] = useState<string>(isoDate(addDays(30)));
  const [sessionMinutes, setSessionMinutes] = useState<number>(25);
  const [daysPerWeek, setDaysPerWeek] = useState<number>(5);
  const [marginHelp, setMarginHelp] = useState<"guided" | "quiet" | "deep_study">("guided");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // If the book already has an active plan, prompt before making a second one.
  const [existingPlan, setExistingPlan] = useState<PlanSummary | null>(null);

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

  async function doConfigure() {
    await invoke("cmd_configure_plan", {
      bookId: book.id,
      targetFinishDate: targetDate,
      daysPerWeek,
      sessionMinutes,
      marginHelp,
    });
    onDone();
  }

  async function startPlan() {
    setSubmitting(true);
    setError(null);
    try {
      // Don't silently stack a second plan: if one is already active, ask first.
      let active: PlanSummary | null = null;
      try {
        active = await invoke<PlanSummary | null>("cmd_get_active_plan", { bookId: book.id });
      } catch {
        active = null;
      }
      if (active) {
        setExistingPlan(active);
        setSubmitting(false);
        return;
      }
      await doConfigure();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setSubmitting(false);
    }
  }

  // Resolve the "this book already has a plan" prompt.
  async function resolveReplan(choice: "continue" | "replace" | "pause") {
    setSubmitting(true);
    setError(null);
    try {
      if (choice === "continue") {
        setExistingPlan(null);
        onDone();
        return;
      }
      if (existingPlan) {
        await invoke(choice === "replace" ? "cmd_archive_plan" : "cmd_pause_plan", {
          planId: existingPlan.id,
        });
      }
      setExistingPlan(null);
      await doConfigure();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setSubmitting(false);
      setExistingPlan(null);
    }
  }

  return (
    <div className="tl-plan-screen">
      <div className="tl-plan-scroll">
        <div className="tl-col tl-plan">
          <div className="tl-kicker"><span className="dot" />New book</div>
          <h1 className="tl-plan-title">{book.title}</h1>
          {book.author && <div className="tl-plan-author">{book.author}</div>}
          <p className="tl-plan-lead">
            Your plan is ready — you are not behind. Set a rhythm, or decide later. The pace clock
            only starts when you begin reading.
          </p>

          <div className="tl-plan-card">
            <div className="tl-plan-row">
              <span className="tl-plan-rowlabel">Finish by</span>
              <Choice<FinishMode>
                label="Finish by"
                value={finishMode}
                set={setFinishMode}
                options={[
                  { v: "week", l: "This week" },
                  { v: "month", l: "This month" },
                  { v: "date", l: "Pick a date" },
                ]}
              />
            </div>
            {finishMode === "date" && (
              <div className="tl-plan-row">
                <span className="tl-plan-rowlabel" />
                <input
                  type="date"
                  className="tl-input"
                  style={{ maxWidth: 200 }}
                  value={customDate}
                  min={isoDate(addDays(1))}
                  onChange={(e) => setCustomDate(e.target.value)}
                  aria-label="Target finish date"
                />
              </div>
            )}
            <div className="tl-plan-row">
              <span className="tl-plan-rowlabel">Session</span>
              <Choice<number>
                label="Session length in minutes"
                value={sessionMinutes}
                set={setSessionMinutes}
                options={MINUTE_PRESETS.map((m) => ({ v: m, l: `${m} min` }))}
              />
            </div>
            <div className="tl-plan-row">
              <span className="tl-plan-rowlabel">Days a week</span>
              <Choice<number>
                label="Reading days per week"
                value={daysPerWeek}
                set={setDaysPerWeek}
                compact
                options={DAY_PRESETS.map((d) => ({ v: d, l: String(d) }))}
              />
            </div>
            <div className="tl-plan-row">
              <span className="tl-plan-rowlabel">Margin help</span>
              <Choice<"guided" | "quiet" | "deep_study">
                label="Margin help"
                value={marginHelp}
                set={setMarginHelp}
                options={[
                  { v: "guided", l: "Guided" },
                  { v: "quiet", l: "Quiet" },
                  { v: "deep_study", l: "Deep study" },
                ]}
              />
            </div>
          </div>

          {est && (
            <div className={"tl-estimate" + (est.feasible ? "" : " tight")} role="note">
              <TLIcon name={est.feasible ? "clock" : "behind"} size={16} />
              <div className="tl-estimate-body">
                <span>
                  About <span className="num">{humanHours(est.minsFast)}–{humanHours(est.minsSlow)}</span> of reading.{" "}
                  {est.feasible
                    ? <>At {sessionMinutes} min × {daysPerWeek} days, that is roughly <span className="num">{est.weeks} week{est.weeks === 1 ? "" : "s"}</span> — comfortably before {targetDate}.</>
                    : null}
                </span>
                {!est.feasible && (
                  <div className="soft-note">
                    <TLIcon name="behind" size={13} />
                    <span>
                      Finishing by {targetDate} would mean about {est.neededPerSession} min per session. At this
                      rhythm it is closer to {est.weeks} week{est.weeks === 1 ? "" : "s"} — give it more time, longer
                      sittings, or more days. Or leave it; nothing is lost.
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <p className="tl-warn-text" role="alert" style={{ marginTop: "var(--tl-4)" }}>Couldn't save the plan: {error}</p>}
        </div>
      </div>

      <div className="tl-actionbar">
        <div className="tl-actionbar-inner">
          <span className="reassure">No streak to break.</span>
          <span className="right">
            <button className="tl-btn tl-btn-ghost" disabled={submitting} onClick={onDone}>Decide later</button>
            <button className="tl-btn tl-btn-primary" disabled={submitting} onClick={startPlan}>
              {submitting ? "Saving…" : "Start this plan"}
            </button>
          </span>
        </div>
      </div>

      {existingPlan && (
        <div className="tl-sheet-backdrop" role="dialog" aria-label="This book already has a plan">
          <div className="tl-plans-sheet" style={{ maxWidth: 460 }}>
            <h3 style={{ marginTop: 0, fontFamily: "var(--tl-serif)", fontWeight: 500 }}>
              This book already has a plan
            </h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Started {existingPlan.start_date}, finishing {existingPlan.target_finish_date} ·{" "}
              {existingPlan.session_count} sessions, {existingPlan.note_count} notes. How do you want to
              handle it?
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--tl-2)", marginTop: "var(--tl-3)" }}>
              <button className="tl-btn tl-btn-primary" disabled={submitting} onClick={() => resolveReplan("continue")}>
                Keep the current plan
              </button>
              <button className="tl-btn tl-btn-ghost" disabled={submitting} onClick={() => resolveReplan("pause")}>
                Pause it and start fresh
              </button>
              <button className="tl-btn tl-btn-ghost" disabled={submitting} onClick={() => resolveReplan("replace")}>
                Replace it (archives the current plan)
              </button>
              <button className="tl-btn-quiet" disabled={submitting} onClick={() => setExistingPlan(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

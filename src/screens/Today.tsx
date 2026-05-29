import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RGIcon, { type IconName } from "../components/RGIcon";
import type { TodayCard, PaceState, RecoveryOption, RecomputedPlan } from "../types";

interface Props {
  today: TodayCard | null;
  onImport: () => void;
  onStart: (t: TodayCard) => void;
  onRefresh: () => Promise<void> | void;
}

// Pace as glyph + word (never color-only) — maps our PaceState to the design's
// .rg-pace classes. Cites guard-accessibility-baseline-wcag-aa item 6.
function paceMeta(p: PaceState): { cls: "on" | "behind"; icon: IconName; word: string } {
  switch (p.kind) {
    case "on_pace":     return { cls: "on",     icon: "check",  word: "On pace" };
    case "behind":      return { cls: "behind", icon: "behind", word: `Behind · ${p.days_behind} day${p.days_behind === 1 ? "" : "s"}` };
    case "recovery":    return { cls: "behind", icon: "behind", word: "Recovery" };
    case "not_started": return { cls: "on",     icon: "clock",  word: "Not started" };
    case "done":        return { cls: "on",     icon: "flag",   word: "Finished" };
  }
}

function optionIcon(o: RecoveryOption): IconName {
  switch (o.kind) {
    case "ResumeToday":            return "book";
    case "GentleCatchup":          return "flag";
    case "WeekendCatchup":         return "flag";
    case "ExtendFinish":           return "refresh";
    case "RestartCurrentChapter":  return "refresh";
  }
}

function describeOption(o: RecoveryOption): { primary: string; detail?: string } {
  switch (o.kind) {
    case "ResumeToday":
      return { primary: "Just read the next section", detail: "Skip recovery — open today's assigned section." };
    case "GentleCatchup":
      return {
        primary: `Add ${o.extra_minutes} min for the next ${o.for_sessions} session${o.for_sessions === 1 ? "" : "s"}`,
        detail: "Small, sustainable bumps until you're caught up.",
      };
    case "WeekendCatchup":
      return {
        primary: o.weekend_starts_in_days === 0 ? "Catch up this weekend" : `Catch up in ${o.weekend_starts_in_days} day(s) (weekend)`,
        detail: "Use the weekend window — no weekday pressure.",
      };
    case "ExtendFinish":
      return {
        primary: `Re-pace to finish by ${o.new_finish}`,
        detail: `Adds ${o.add_days} day${o.add_days === 1 ? "" : "s"}; recomputes the daily plan. Completed sections stay completed.`,
      };
    case "RestartCurrentChapter":
      return { primary: "Restart current chapter", detail: "Clear today's section progress and start over." };
  }
}

export default function Today({ today, onImport, onStart, onRefresh }: Props) {
  if (!today) {
    return (
      <div className="rg-welcome">
        <div className="rg-welcome-card">
          <div className="mark"><RGIcon name="book" size={26} /></div>
          <h1>Welcome to ReadingGym</h1>
          <p>One book at a time, a little each day. Import something you mean to finish, and it'll be waiting on Today.</p>
          <button className="rg-btn rg-btn-primary" style={{ margin: "0 auto" }} onClick={onImport}>
            <RGIcon name="upload" size={18} /> Import a book
          </button>
          <div className="hint">Supports .txt and .epub · stays on this Mac</div>
        </div>
      </div>
    );
  }

  const { book, section, section_completed, estimated_minutes, monthly_pct, pace, day_index, total_days, streak, recovery } = today;
  const pm = paceMeta(pace);

  return (
    <div className="rg-col rg-today">
      <div className="rg-kicker"><span className="dot" />Today — day {day_index} of {total_days}</div>

      <h1 className="rg-today-title">{book.title}</h1>
      {book.author && <div className="rg-today-author">{book.author}</div>}

      {section ? (
        <>
          <div className="rg-section-label">{section.label}</div>
          <div className="rg-meta">
            <span className="item"><RGIcon name="clock" size={15} /> ≈ {estimated_minutes} min</span>
            <span className="sep" />
            <span className="item">{monthly_pct}% complete</span>
            <span className="sep" />
            <span className={`rg-pace ${pm.cls}`} aria-label={`Pace: ${pm.word}`}>
              <RGIcon name={pm.icon} size={15} /> {pm.word}
            </span>
          </div>
        </>
      ) : (
        <div className="rg-section-label" style={{ fontStyle: "normal", color: "var(--rg-muted)" }}>
          {pace.kind === "done" ? "You finished the book." : "No section assigned."}
        </div>
      )}

      <button className="rg-btn rg-btn-primary block" disabled={!section} onClick={() => onStart(today)}>
        <RGIcon name="book" size={18} /> {section_completed ? "Re-open today's section" : "Start reading"}
      </button>

      <div className="rg-streak">
        <span className="rg-dots" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i} className={i < streak.days_read_last_7 ? "d read" : "d"} />
          ))}
        </span>
        <span>You read {streak.days_read_last_7} of the last 7 days.</span>
      </div>

      {recovery && <RecoveryPanel bundle={recovery} bookId={book.id} sectionId={section?.id ?? null} onRefresh={onRefresh} />}

      <hr className="rg-divline" style={{ marginTop: "calc(var(--rg-7) * var(--rg-density))" }} />
      <button className="rg-btn-quiet" style={{ marginTop: "var(--rg-3)" }} onClick={onImport}>
        <RGIcon name="plus" size={16} /> Import another book
      </button>
    </div>
  );
}

function RecoveryPanel(props: {
  bundle: import("../types").RecoveryBundle;
  bookId: string;
  sectionId: string | null;
  onRefresh: () => Promise<void> | void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Two-stage confirm for the only destructive recovery action.
  const [pendingRestart, setPendingRestart] = useState(false);

  async function actOn(option: RecoveryOption) {
    setMessage(null);
    if (option.kind === "RestartCurrentChapter") {
      if (!props.sectionId) { setMessage("No current section to restart."); return; }
      setPendingRestart(true);
      return;
    }
    setWorking(option.kind);
    try {
      switch (option.kind) {
        case "ResumeToday":
          setMessage("Just start reading — the next assigned section is ready.");
          break;
        case "GentleCatchup":
          setMessage(`Plan: add ${option.extra_minutes} min for the next ${option.for_sessions} sessions.`);
          break;
        case "WeekendCatchup":
          setMessage("Plan: use the weekend window.");
          break;
        case "ExtendFinish": {
          const r = await invoke<RecomputedPlan>("cmd_extend_finish_date", { bookId: props.bookId, addDays: option.add_days });
          setMessage(`Finish date is now ${r.new_target_finish_date}. ${r.remaining_sections} section${r.remaining_sections === 1 ? "" : "s"} across ${r.remaining_days} day${r.remaining_days === 1 ? "" : "s"}.`);
          await props.onRefresh();
          break;
        }
      }
    } catch (e: any) {
      setMessage(`Failed: ${e?.message ?? e}`);
    } finally {
      setWorking(null);
    }
  }

  async function confirmRestart() {
    if (!props.sectionId) return;
    setWorking("RestartCurrentChapter");
    setPendingRestart(false);
    try {
      await invoke("cmd_restart_current_section", { bookId: props.bookId, sectionId: props.sectionId });
      setMessage("Current section progress cleared. Open the reader to start over.");
      await props.onRefresh();
    } catch (e: any) {
      setMessage(`Failed: ${e?.message ?? e}`);
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="rg-recovery">
      <div className="head"><RGIcon name="behind" size={16} /> A little behind — that's alright.</div>
      <div className="lead">
        Behind by {props.bundle.days_behind} day{props.bundle.days_behind === 1 ? "" : "s"}. Pick how to get back in — no catch-up marathon required.
      </div>
      <div className="opts">
        {props.bundle.options.map((o, i) => {
          const d = describeOption(o);
          return (
            <button key={i} className="rg-opt" onClick={() => actOn(o)} disabled={working !== null}>
              <span>
                <span className="t">{working === o.kind ? "…" : d.primary}</span>
                {d.detail && <span className="s">{d.detail}</span>}
              </span>
              <RGIcon name={optionIcon(o)} size={18} />
            </button>
          );
        })}
      </div>
      {pendingRestart && (
        <div className="rg-recovery" role="alert" style={{ marginTop: "var(--rg-3)", borderColor: "var(--rg-alert)", background: "var(--rg-alert-soft)" }}>
          <p className="lead" style={{ margin: 0 }}>
            Restart current chapter? This clears your saved progress and resume position for the section. Note history and reading sessions are kept.
          </p>
          <div style={{ display: "flex", gap: "var(--rg-2)", justifyContent: "flex-end", marginTop: "var(--rg-3)" }}>
            <button className="rg-btn rg-btn-ghost" onClick={() => setPendingRestart(false)}>Cancel</button>
            <button className="rg-btn rg-btn-primary" onClick={confirmRestart}>Yes, restart this chapter</button>
          </div>
        </div>
      )}
      {message && <p className="lead" style={{ marginTop: "var(--rg-3)", marginBottom: 0, color: "var(--rg-ok)" }}>{message}</p>}
    </div>
  );
}

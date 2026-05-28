import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TodayCard, PaceState, RecoveryOption, RecomputedPlan } from "../types";

interface Props {
  today: TodayCard | null;
  onImport: () => void;
  onStart: (t: TodayCard) => void;
  onRefresh: () => Promise<void> | void;
}

function paceLabel(p: PaceState): { label: string; tone: "ok" | "warn" | "alert" | "muted"; glyph: string } {
  // Glyph + text combo so color isn't the only signal of pace state — meets
  // WCAG 1.4.1 / `guard-accessibility-baseline-wcag-aa` item 6 (color independence).
  switch (p.kind) {
    case "on_pace":     return { glyph: "✓", label: "On pace", tone: "ok" };
    case "behind":      return { glyph: "⚠", label: `Behind by ${p.days_behind}`, tone: "warn" };
    case "recovery":    return { glyph: "△", label: "Recovery", tone: "alert" };
    case "not_started": return { glyph: "·", label: "Not started", tone: "muted" };
    case "done":        return { glyph: "✓", label: "Finished", tone: "ok" };
  }
}

function describeOption(o: RecoveryOption): { primary: string; detail?: string } {
  switch (o.kind) {
    case "ResumeToday":
      return { primary: "Resume today", detail: "Skip recovery — just read the next assigned section." };
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
        primary: `Extend finish date by ${o.add_days} day${o.add_days === 1 ? "" : "s"}`,
        detail: `New finish: ${o.new_finish}. Recomputes the daily plan; completed sections stay completed.`,
      };
    case "RestartCurrentChapter":
      return { primary: "Restart current chapter", detail: "Clear today's section progress and start over." };
  }
}

export default function Today({ today, onImport, onStart, onRefresh }: Props) {
  if (!today) {
    return (
      <section className="screen">
        <div className="card welcome">
          <h1>Welcome to ReadingGym</h1>
          <p className="muted">
            One serious book. Today's section. One useful note. Local Markdown.
          </p>
          <button className="primary" onClick={onImport}>Import a book (.txt or .epub)</button>
          <p className="hint">
            Augustine's <em>Confessions</em> from Project Gutenberg or any DRM-free EPUB from Standard Ebooks works well as a first book.
          </p>
        </div>
      </section>
    );
  }

  const { book, section, section_completed, estimated_minutes, monthly_pct, pace, day_index, total_days, streak, recovery } = today;
  const p = paceLabel(pace);

  return (
    <section className="screen">
      <div className="card today-card">
        <div className="kicker">Today — day {day_index} of {total_days}</div>
        <h1 className="title">{book.title}</h1>
        {book.author && <div className="author">{book.author}</div>}

        {section ? (
          <div className="section-block">
            <div className="section-label">{section.label}</div>
            <div className="section-meta">
              <span>≈ {estimated_minutes} min</span>
              <span className="dot">·</span>
              <span>{monthly_pct}% complete</span>
              <span className="dot">·</span>
              <span className={`pace pace-${p.tone}`} aria-label={`Pace: ${p.label}`}>
                <span aria-hidden="true">{p.glyph}</span> {p.label}
              </span>
            </div>
          </div>
        ) : (
          <div className="section-block">
            <div className="muted">No section assigned. {pace.kind === "done" ? "You finished the book." : ""}</div>
          </div>
        )}

        <button
          className="primary big"
          disabled={!section}
          onClick={() => onStart(today)}
        >
          {section_completed ? "Re-open today's section" : "Start Reading"}
        </button>

        {section_completed && (
          <p className="hint">Today's section is marked complete.</p>
        )}

        <div className="streak">
          You read {streak.days_read_last_7} of the last 7 days
          {streak.minutes_last_7 > 0 && ` — ${streak.minutes_last_7} min`}.
        </div>

        <button className="today-import" onClick={onImport}>+ Import another book</button>
      </div>

      {recovery && <RecoveryPanel bundle={recovery} bookId={book.id} sectionId={section?.id ?? null} onRefresh={onRefresh} />}
    </section>
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
  // (`pat-interaction-pattern-catalog-seed` rule 2 — Safe Exploration.)
  const [pendingRestart, setPendingRestart] = useState(false);

  async function actOn(option: RecoveryOption) {
    setMessage(null);
    // RestartCurrentChapter is destructive — surface a confirm step first.
    if (option.kind === "RestartCurrentChapter") {
      if (!props.sectionId) {
        setMessage("No current section to restart.");
        return;
      }
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
          setMessage(`Plan: add ${option.extra_minutes} min for the next ${option.for_sessions} sessions. (No schedule change in the database.)`);
          break;
        case "WeekendCatchup":
          setMessage("Plan: use the weekend window. No schedule change in the database.");
          break;
        case "ExtendFinish": {
          const r = await invoke<RecomputedPlan>("cmd_extend_finish_date", {
            bookId: props.bookId,
            addDays: option.add_days,
          });
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
    <div className="card recovery-card">
      <div className="kicker">Recovery</div>
      <h2 className="recovery-headline">{props.bundle.headline}</h2>
      <p className="muted small">Behind by {props.bundle.days_behind} day{props.bundle.days_behind === 1 ? "" : "s"}. Shame-free options:</p>
      <ul className="recovery-list">
        {props.bundle.options.map((o, i) => {
          const d = describeOption(o);
          return (
            <li key={i} className="recovery-row">
              <button
                className="recovery-btn"
                onClick={() => actOn(o)}
                disabled={working !== null}
              >
                {working === o.kind ? "…" : d.primary}
              </button>
              {d.detail && <span className="recovery-detail muted small">{d.detail}</span>}
            </li>
          );
        })}
      </ul>
      {pendingRestart && (
        <div className="recovery-confirm" role="alert">
          <p className="warn">
            Restart current chapter? This clears your saved progress and resume position for the
            section. The note history and reading sessions are kept.
          </p>
          <div className="panel-actions">
            <button className="ghost" onClick={() => setPendingRestart(false)}>Cancel</button>
            <button className="primary" onClick={confirmRestart}>Yes, restart this chapter</button>
          </div>
        </div>
      )}
      {message && <p className="recovery-message">{message}</p>}
    </div>
  );
}

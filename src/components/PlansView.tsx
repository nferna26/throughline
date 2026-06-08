import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon, { type IconName } from "./TLIcon";
import type { PlanSummary, TodayCard } from "../types";

/**
 * Plans for a book — the "frontispiece + back-matter" view (design handoff).
 * The live plan is one large accented plate; earlier attempts are quiet dated
 * back-matter. "Which plan is live?" is answered by hierarchy, not a badge. Tone is
 * the spec: pausing / restarting / letting go never read as failure.
 */

type Meta = { word: string; icon: IconName | null; tone: "accent" | "muted"; live?: boolean };
function planMeta(lifecycle: string): Meta {
  switch (lifecycle) {
    case "active": return { word: "Live", icon: null, tone: "accent", live: true };
    case "paused": return { word: "Paused", icon: "pause", tone: "muted" };
    case "completed": return { word: "Finished", icon: "flag", tone: "muted" };
    case "superseded": return { word: "Replaced", icon: "swap", tone: "muted" };
    case "archived": return { word: "Set aside", icon: "archive", tone: "muted" };
    default: return { word: lifecycle, icon: null, tone: "muted" };
  }
}

function StateTag({ lifecycle }: { lifecycle: string }) {
  const m = planMeta(lifecycle);
  return (
    <span className={`tl-state ${m.tone}`}>
      {m.live ? <span className="live-dot" /> : m.icon && <TLIcon name={m.icon} size={13} />}
      {m.word}
    </span>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : iso;
}

export default function PlansView({
  bookId,
  bookTitle,
  bookAuthor,
  today,
  onClose,
  onContinueReading,
  onStartNewPlan,
  onChanged,
}: {
  bookId: string;
  bookTitle: string;
  bookAuthor?: string | null;
  today: TodayCard | null;
  onClose: () => void;
  onContinueReading: () => void;
  onStartNewPlan: () => void;
  onChanged?: () => void;
}) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [undoId, setUndoId] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const load = useCallback(
    () => invoke<PlanSummary[]>("cmd_list_plans_for_book", { bookId }).then(setPlans).catch(() => setPlans([])),
    [bookId],
  );
  useEffect(() => {
    load();
  }, [load]);

  // Esc closes the view (a calm, reversible navigation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const act = async (cmd: string, planId: string) => {
    await invoke(cmd, { planId });
    await load();
    onChanged?.();
  };
  const letGo = async (planId: string) => {
    await invoke("cmd_delete_plan", { planId });
    await load();
    onChanged?.();
    setUndoId(planId);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setUndoId(null), 6000);
  };
  const doUndo = async () => {
    if (!undoId) return;
    await invoke("cmd_restore_plan", { planId: undoId });
    setUndoId(null);
    await load();
    onChanged?.();
  };

  const live = plans?.find((p) => p.lifecycle === "active") ?? null;
  const past = plans?.filter((p) => p.lifecycle !== "active") ?? [];
  const behind = today?.pace?.kind === "behind";

  return (
    <div className="tl-plans-screen">
      <div className="tl-plans-scroll">
        <div className="tl-plans-col">
          <button className="tl-back" onClick={onClose}>
            <TLIcon name="chevronLeft" size={18} /> Today
          </button>
          <div className="tl-plans-top">
            <div className="tl-eyebrow"><span className="dot" /> Plans for this book</div>
            <h1 className="tl-plans-book">{bookTitle}</h1>
            {bookAuthor && <div className="tl-plans-byline">{bookAuthor}</div>}
          </div>

          {live ? (
            <div className="fp-live">
              <StateTag lifecycle="active" />
              <div className="fp-name">{live.name || "Current plan"}</div>
              <div className="fp-sub">
                Started {fmtDate(live.start_date)} · aiming at {fmtDate(live.target_finish_date)}
              </div>
              <div className="fp-progress">
                <div className="fp-track">
                  <div className="fp-fill" style={{ width: `${today?.monthly_pct ?? 0}%` }} />
                </div>
                <div className="fp-progress-meta">
                  {today && (
                    <>
                      <span><span className="strong">Day {today.day_index}</span> of {today.total_days}</span>
                      <span className="sep" />
                    </>
                  )}
                  <span>{today?.monthly_pct ?? 0}% through</span>
                  {behind && (
                    <>
                      <span className="sep" />
                      <span className="fp-pace"><TLIcon name="behind" size={14} /> a little behind — that's fine</span>
                    </>
                  )}
                </div>
              </div>
              <div className="fp-actions">
                <button className="tl-btn tl-btn-primary" onClick={onContinueReading}>
                  <TLIcon name="book" size={16} /> Continue reading
                </button>
                <button className="tl-act" onClick={() => act("cmd_pause_plan", live.id)}>
                  <TLIcon name="pause" size={14} /> Pause this plan
                </button>
              </div>
            </div>
          ) : (
            <div className="tl-plans-empty">
              <span className="mark"><TLIcon name="book" size={22} /></span>
              <span className="big">{past.length > 0 ? "No live plan right now" : "No plan yet"}</span>
              <p>
                {past.length > 0
                  ? "This book is resting. Pick up an earlier attempt below, or start a fresh plan whenever you’re ready."
                  : "Set a gentle pace whenever you’re ready — a few pages a day is plenty. There’s no rush."}
              </p>
              <button className="tl-btn tl-btn-primary" style={{ margin: "4px auto 0" }} onClick={onStartNewPlan}>
                <TLIcon name="flag" size={16} /> {past.length > 0 ? "Start a new plan" : "Start your first plan"}
              </button>
            </div>
          )}

          {past.length > 0 && (
            <div className="fp-history">
              <div className="fp-history-label">Earlier attempts · kept as history</div>
              <div className="fp-entries">
                {past.map((p) => (
                  <div className="fp-entry" key={p.id} tabIndex={0}>
                    <div className="em-name">{p.name || planMeta(p.lifecycle).word}</div>
                    <div className="em-meta">
                      <StateTag lifecycle={p.lifecycle} />
                      <span className="sep" />
                      <span>
                        {fmtDate(p.start_date)}
                        {p.reached_percent != null ? ` · reached ${p.reached_percent}%` : ""}
                      </span>
                      <span className="sep" />
                      <span>{p.note_count} note{p.note_count === 1 ? "" : "s"} kept</span>
                    </div>
                    <div className="em-actions">
                      {p.lifecycle === "paused" && (
                        <button className="tl-act accent" onClick={() => act("cmd_resume_plan", p.id)}>
                          <TLIcon name="play" size={13} /> Resume
                        </button>
                      )}
                      {p.lifecycle === "completed" && (
                        <button className="tl-act" onClick={onStartNewPlan}>
                          <TLIcon name="book" size={14} /> Read again
                        </button>
                      )}
                      {p.lifecycle !== "completed" && p.lifecycle !== "archived" && (
                        <button className="tl-act" onClick={() => act("cmd_archive_plan", p.id)}>
                          <TLIcon name="archive" size={14} /> Set aside
                        </button>
                      )}
                      <button className="tl-act danger" onClick={() => letGo(p.id)}>
                        <TLIcon name="undo" size={14} /> Let go
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="tl-plans-actionbar">
        <div className="tl-plans-actionbar-inner">
          <span className="note">Pausing and restarting are part of reading a hard book.</span>
          <span className="right">
            <button className="tl-btn tl-btn-ghost" onClick={onStartNewPlan}>
              <TLIcon name="flag" size={15} /> Start a new plan
            </button>
          </span>
        </div>
      </div>

      {undoId && (
        <div className="tl-plans-toast" role="status" aria-live="polite">
          <span>Plan let go — notes kept for 30 days.</span>
          <button onClick={doUndo}>Undo</button>
        </div>
      )}
    </div>
  );
}

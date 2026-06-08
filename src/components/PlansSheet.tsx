import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlanSummary } from "../types";

/**
 * Plan management sheet (Epic A3): see every plan for a book and pause / resume /
 * archive / delete it. Closes the "no place to see or delete active plans" gap.
 * Delete is double-confirmed and names the attached sessions + notes it removes.
 */
export default function PlansSheet({
  bookId,
  bookTitle,
  onClose,
}: {
  bookId: string;
  bookTitle: string;
  onClose: () => void;
}) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = () =>
    invoke<PlanSummary[]>("cmd_list_plans_for_book", { bookId })
      .then(setPlans)
      .catch(() => setPlans([]));
  useEffect(() => {
    load();
  }, [bookId]);

  const act = async (cmd: string, args: Record<string, unknown>) => {
    await invoke(cmd, args);
    setConfirmDelete(null);
    load();
  };

  return (
    <div className="tl-sheet-backdrop" role="dialog" aria-label="Reading plans" onClick={onClose}>
      <div className="tl-plans-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="tl-plans-head">
          <h3>Plans · {bookTitle}</h3>
          <button className="tl-btn-quiet" onClick={onClose}>
            Done
          </button>
        </header>
        {!plans ? (
          <p className="hint">Loading…</p>
        ) : plans.length === 0 ? (
          <p className="hint">No plans for this book yet.</p>
        ) : (
          <ul className="tl-plans-list">
            {plans.map((p) => (
              <li key={p.id} className="tl-plan-row">
                <div className="tl-plan-main">
                  <span className={`tl-plan-badge is-${p.lifecycle}`}>{p.lifecycle}</span>
                  <span className="tl-plan-dates">
                    {p.start_date} → {p.target_finish_date}
                  </span>
                  <span className="tl-plan-counts">
                    {p.session_count} session{p.session_count === 1 ? "" : "s"} · {p.note_count} note
                    {p.note_count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="tl-plan-actions">
                  {p.lifecycle === "active" && (
                    <button className="tl-btn-quiet" onClick={() => act("cmd_pause_plan", { planId: p.id })}>
                      Pause
                    </button>
                  )}
                  {p.lifecycle === "paused" && (
                    <button className="tl-btn-quiet" onClick={() => act("cmd_resume_plan", { planId: p.id })}>
                      Resume
                    </button>
                  )}
                  {p.lifecycle !== "archived" && (
                    <button className="tl-btn-quiet" onClick={() => act("cmd_archive_plan", { planId: p.id })}>
                      Archive
                    </button>
                  )}
                  {confirmDelete === p.id ? (
                    <span className="tl-plan-confirm">
                      Delete {p.session_count} session{p.session_count === 1 ? "" : "s"} + {p.note_count} note
                      {p.note_count === 1 ? "" : "s"}?
                      <button
                        className="tl-btn-quiet tl-danger"
                        onClick={() => act("cmd_delete_plan", { planId: p.id, cascadeSessions: true })}
                      >
                        Delete
                      </button>
                      <button className="tl-btn-quiet" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button className="tl-btn-quiet tl-danger" onClick={() => setConfirmDelete(p.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

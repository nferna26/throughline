import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon, { type IconName } from "../components/TLIcon";
import TodayTeaser from "../components/TodayTeaser";
import PlansView from "../components/PlansView";
import RePlanDialog from "../components/RePlanDialog";
import type { TodayCard, PaceState, RecoveryOption, RecomputedPlan, FinishForecast, Book, PlanSummary } from "../types";

interface Props {
  today: TodayCard | null;
  /** Open the public-domain catalogue (the primary "get a book" path). */
  onDiscover: () => void;
  /** Import a local .txt/.epub via the file picker (the secondary path). */
  onImport: () => void;
  onStart: (t: TodayCard) => void;
  /** The calm "I only have 10 minutes" path — opens the reader in rescue mode. */
  onStartRescue: (t: TodayCard) => void;
  onRefresh: () => Promise<void> | void;
  /** Create a fresh plan for the book and open its setup (the new-plan flow). */
  onNewPlan?: (book: Book) => void;
  /** Jump to the Notes tab (the finished-book "Review your notes" action). */
  onReviewNotes?: () => void;
}

// Honest, low-drama forecast caption for an active plan. `on_track` needs no
// line (the pace chip already says "On pace"); the heavier needs_rebalance /
// plan_unrealistic states are owned by the recovery panel, so we don't double up.
// `slightly_off_pace` is the one state the pace chip hides (it maps to OnPace),
// so surfacing it here is the whole point.
function forecastNote(f: FinishForecast | null | undefined, planReady: boolean): string | null {
  if (planReady || !f) return null;
  if (f.state === "slightly_off_pace") {
    return "Slightly off your original pace — a session today keeps the finish date within reach.";
  }
  if (f.state === "on_track" && f.projected_finish_date) {
    return `On track to finish around ${f.projected_finish_date}.`;
  }
  return null;
}

// Pace as glyph + word (never color-only) — maps our PaceState to the design's
// .tl-pace classes. Cites guard-accessibility-baseline-wcag-aa item 6.
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
  }
}

// CORE-1007: GentleCatchup and WeekendCatchup are ADVICE — they change no
// state and persist nothing, so their copy must never read as a commitment
// ("Plan: …"). ExtendFinish is the one option that really mutates the plan.
function describeOption(o: RecoveryOption): { primary: string; detail?: string } {
  switch (o.kind) {
    case "ResumeToday":
      return { primary: "Just read the next section", detail: "Skip recovery — open today's assigned section." };
    case "GentleCatchup":
      return {
        primary: `Try adding ${o.extra_minutes} min to your next few sittings`,
        detail: "Just advice — nothing in your plan changes.",
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
  }
}

export default function Today({ today, onDiscover, onImport, onStart, onStartRescue, onRefresh, onNewPlan, onReviewNotes }: Props) {
  const [showPlans, setShowPlans] = useState(false);
  const [plansCount, setPlansCount] = useState(0);
  const [replanActive, setReplanActive] = useState<PlanSummary | null>(null);
  const bookId = today?.book.id;
  // How many plans this book has — drives the "Plans · N earlier" pill (only >1).
  useEffect(() => {
    if (!bookId) {
      setPlansCount(0);
      return;
    }
    Promise.resolve()
      .then(() => invoke<PlanSummary[]>("cmd_list_plans_for_book", { bookId }))
      .then((p) => setPlansCount(Array.isArray(p) ? p.length : 0))
      .catch(() => setPlansCount(0));
  }, [bookId, showPlans]);
  if (!today) {
    return (
      <div className="tl-welcome">
        <div className="tl-welcome-card">
          <div className="mark"><TLIcon name="book" size={26} /></div>
          <h1>Welcome to Throughline</h1>
          <p>One book at a time, a little each day. Find something you mean to finish, and it'll be waiting on Today.</p>
          <ul className="tl-welcome-promise" aria-label="How Throughline treats your reading">
            <li><TLIcon name="check" size={15} /> Your books stay on this Mac. If you ask the tutor, only the passage you select is sent — never the book.</li>
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

  const { book, section, section_completed, estimated_minutes, session_minutes, monthly_pct, pace, day_index, total_days, streak, recovery, plan_status, forecast, memory, teaser } = today;

  // CORE-1004: a book whose every plan was let go still owns Today — the book
  // header stays, the pace clock is silent, and the one obvious action is
  // starting a plan (the existing onNewPlan flow → setup sheet). Without this
  // branch the reader would meet a dead "No section assigned" card.
  if (plan_status === "no_plan") {
    return (
      <div className="tl-col tl-today">
        <div className="tl-kicker"><span className="dot" /> Today</div>
        <h1 className="tl-today-title">{book.title}</h1>
        {book.author && <div className="tl-today-author">{book.author}</div>}
        <div className="tl-plans-empty">
          <span className="mark"><TLIcon name="book" size={22} /></span>
          <span className="big">No plan right now</span>
          <p>Set a gentle pace whenever you're ready — a few pages a day is plenty. There's no rush.</p>
          <button className="tl-btn tl-btn-primary" style={{ margin: "4px auto 0" }} onClick={() => onNewPlan?.(book)}>
            <TLIcon name="flag" size={16} /> Start a plan
          </button>
        </div>
        <LastTime memory={memory} />
      </div>
    );
  }

  const pm = paceMeta(pace);
  // A freshly imported book's plan hasn't started its pace clock yet. It is, by
  // design, NEVER behind — the copy here must say so plainly and calmly.
  const planReady = plan_status === "plan_ready";
  // A paused plan's clock is stopped (CORE-1003): the kicker must read calmly,
  // never keep counting "day N of M" through the pause.
  const paused = plan_status === "paused";
  const fcNote = forecastNote(forecast, planReady);
  // "Continue where you left off": a saved mid-section position from a prior
  // sitting (not a fresh plan, not a completed section). The reader resumes at
  // the exact paragraph either way — this just names it so re-entry feels like
  // picking a thought back up rather than restarting. `resume_percent` is the
  // within-section progress the reader last reached.
  const resumePct = today.resume_percent ?? 0;
  const isResuming = !planReady && !section_completed && !!section && resumePct >= 3 && resumePct < 97;
  const primaryLabel = !section
    ? "Start reading"
    : planReady
      ? `Start your first ${session_minutes}-minute session`
      : section_completed
        ? `Read on — ${session_minutes} more minutes`
        : isResuming
          ? `Continue — ${Math.round(resumePct)}% into this section`
          : `Start ${session_minutes}-minute session`;

  return (
    <div className="tl-col tl-today">
      <div className="tl-kicker">
        <span className="dot" />
        {planReady ? "Today" : paused ? "Paused — resume whenever you're ready" : `Today — day ${day_index} of ${total_days}`}
        {plansCount > 1 && (
          <button className="tl-plans-link" onClick={() => setShowPlans(true)} aria-label="See plans for this book">
            <TLIcon name="swap" size={14} /> Plans <span className="cnt">· {plansCount - 1} earlier</span>
          </button>
        )}
      </div>

      <h1 className="tl-today-title">{book.title}</h1>
      {book.author && <div className="tl-today-author">{book.author}</div>}

      {section ? (
        <>
          <div className="tl-section-label">{section.label}</div>
          <div className="tl-meta">
            <span className="item"><TLIcon name="clock" size={15} /> ≈ {estimated_minutes} min</span>
            <span className="sep" />
            {/* CORE-1067: "0% complete" on a not-yet-started book is a true but
                useless stat at the moment the app should feel like an invitation.
                Show progress (and its separator) only once there is some. */}
            {monthly_pct > 0 && (
              <>
                <span className="item">{monthly_pct}% complete</span>
                <span className="sep" />
              </>
            )}
            {/* FT-19 (CORE-1052): the plan-ready fact lives in the single note
                below — the chip must not echo it. A not-yet-started plan reads
                its calm pace ("Not started"); a paused plan reads "Paused". */}
            {paused ? (
              <span className="tl-pace on" aria-label="Pace: Paused">
                <TLIcon name="clock" size={15} /> Paused
              </span>
            ) : (
              <span className={`tl-pace ${pm.cls}`} aria-label={`Pace: ${pm.word}`}>
                <TLIcon name={pm.icon} size={15} /> {pm.word}
              </span>
            )}
          </div>
          {planReady && (
            <p className="tl-planready-note">
              Plan ready. You are not behind. Start today or begin tomorrow.
            </p>
          )}
          {fcNote && <p className="tl-forecast-note">{fcNote}</p>}
        </>
      ) : pace.kind === "done" ? (
        <div className="tl-finished-card">
          <span className="mark"><TLIcon name="flag" size={22} /></span>
          <h2>You finished {book.title}</h2>
          <p>
            {memory.note_count} note{memory.note_count === 1 ? "" : "s"} · {memory.highlight_count} highlight
            {memory.highlight_count === 1 ? "" : "s"} · {total_days} day{total_days === 1 ? "" : "s"}.
            Beautifully done — sit with it, or pick up something new.
          </p>
          <div className="tl-finished-actions">
            {onReviewNotes && (
              <button className="tl-btn tl-btn-ghost" onClick={onReviewNotes}>
                <TLIcon name="note" size={16} /> Review your notes
              </button>
            )}
            <button className="tl-btn tl-btn-primary" onClick={onDiscover}>
              <TLIcon name="search" size={16} /> Find another book
            </button>
          </div>
        </div>
      ) : (
        <div className="tl-section-label" style={{ fontStyle: "normal", color: "var(--tl-muted)" }}>
          No section assigned.
        </div>
      )}

      {/* "Where you left off" — the resume thread. A fresh section's opening is
          NOT pre-printed (the reader meets it the instant they tap Start), so this
          shows ONLY when the teaser is the resume excerpt: the sentence being
          returned to, plus one hand-written prompt. No AI, no gamification. */}
      {section && !section_completed && teaser?.is_resume_excerpt && (
        <TodayTeaser teaser={teaser} />
      )}

      {isResuming && (
        <p className="tl-resume-note" role="note">
          <TLIcon name="book" size={14} /> You left off about {Math.round(resumePct)}% into {section!.label}. It opens right where you stopped.
        </p>
      )}
      {pace.kind !== "done" && (
        <>
          <button className="tl-btn tl-btn-primary block" disabled={!section} onClick={() => onStart(today)}>
            <TLIcon name="book" size={18} /> {primaryLabel}
          </button>
          {/* Always offered, never the loud option: a 10-minute "just stay
              connected" sitting. Same reader, calm framing, no pace pressure. */}
          <button className="tl-btn tl-btn-ghost tl-rescue-btn" disabled={!section} onClick={() => onStartRescue(today)}>
            <TLIcon name="clock" size={16} /> I only have 10 minutes
          </button>
        </>
      )}

      {/* CORE-1053: a fresh install must not meet a zero-count ledger (seven
          hollow dots under "You read 0 of the last 7 days."). Stay silent until
          there's a day to count — mirroring LastTime's fresh-book quiet. */}
      {streak.days_read_last_7 > 0 && (
        <div className="tl-streak">
          <span className="tl-dots" aria-hidden="true">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i} className={i < streak.days_read_last_7 ? "d read" : "d"} />
            ))}
          </span>
          <span>You read {streak.days_read_last_7} of the last 7 days.</span>
        </div>
      )}

      <LastTime memory={memory} />

      {recovery && <RecoveryPanel bundle={recovery} bookId={book.id} sectionId={section?.id ?? null} onRefresh={onRefresh} />}

      {pace.kind !== "done" && (
        <>
          <hr className="tl-divline" style={{ marginTop: "calc(var(--tl-7) * var(--tl-density))" }} />
          <button className="tl-btn-quiet" style={{ marginTop: "var(--tl-3)" }} onClick={onDiscover}>
            <TLIcon name="plus" size={16} /> Find another book
          </button>
        </>
      )}

      {showPlans && (
        <PlansView
          bookId={book.id}
          bookTitle={book.title}
          bookAuthor={book.author}
          today={today}
          onClose={() => setShowPlans(false)}
          onContinueReading={() => { setShowPlans(false); onStart(today); }}
          onStartNewPlan={async () => {
            const active = await invoke<PlanSummary | null>("cmd_get_active_plan", { bookId: book.id }).catch(() => null);
            if (active) setReplanActive(active);
            else onNewPlan?.(book);
          }}
          onChanged={() => { onRefresh(); }}
        />
      )}
      {replanActive && (
        <RePlanDialog
          bookTitle={book.title}
          planName={replanActive.name}
          progressLine={`day ${today.day_index} of ${today.total_days}`}
          onCancel={() => setReplanActive(null)}
          onResolve={async (choice) => {
            const active = replanActive;
            setReplanActive(null);
            if (choice === "keep") { setShowPlans(false); return; }
            if (choice === "pause") await invoke("cmd_pause_plan", { planId: active.id });
            else await invoke("cmd_archive_plan", { planId: active.id });
            onNewPlan?.(book);
          }}
        />
      )}
    </div>
  );
}

// "Last time" — a calm, no-shame re-entry surface built from local DB data.
// Shows the reader's most recent Takeaway/Question to pick a thought back up,
// plus quiet counts. Nothing dashboard-y; renders nothing for a fresh book.
function LastTime({ memory }: { memory: import("../types").TodayMemory }) {
  const cap = memory.last_capture;
  const counts: string[] = [];
  if (memory.highlight_count > 0) counts.push(`${memory.highlight_count} highlight${memory.highlight_count === 1 ? "" : "s"}`);
  if (memory.note_count > 0) counts.push(`${memory.note_count} note${memory.note_count === 1 ? "" : "s"}`);
  const countLine = counts.join(" · ");

  if (!cap && !countLine) return null; // fresh book — stay quiet

  if (!cap) {
    // Captures exist but no takeaway/question yet — one quiet line, no nudge spam.
    return <div className="tl-lasttime quiet"><span>{countLine} so far.</span></div>;
  }

  const verb = cap.note_type === "Question" ? "You asked" : "You noted";
  return (
    <div className="tl-lasttime" role="note" aria-label="Last time">
      <div className="tl-lasttime-head">
        <span className="tl-lasttime-kicker"><TLIcon name={cap.note_type === "Question" ? "help" : "sparkle"} size={13} /> Last time</span>
        {cap.chapter_label && <span className="tl-lasttime-loc">{cap.chapter_label}</span>}
      </div>
      <p className="tl-lasttime-body">{verb}: <span className="tl-lasttime-quote">“{cap.body.length > 200 ? cap.body.slice(0, 200).trim() + "…" : cap.body}”</span></p>
      {countLine && <p className="tl-lasttime-counts">{countLine}</p>}
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
  // The message slot carries its own tone: the happy path stays calm green; a
  // failure speaks up as an alert, never in success-green (FT-39).
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  async function actOn(option: RecoveryOption) {
    setMessage(null);
    setWorking(option.kind);
    try {
      switch (option.kind) {
        case "ResumeToday":
          setMessage({ tone: "ok", text: "Just start reading — the next assigned section is ready." });
          break;
        // Advice options (CORE-1007): no backend call, no persistence — so the
        // message must read as advice, never as a saved plan change.
        case "GentleCatchup":
          setMessage({ tone: "ok", text: `Try adding ${option.extra_minutes} minutes to your next few sittings — no setting to change, just sit a little longer.` });
          break;
        case "WeekendCatchup":
          setMessage({ tone: "ok", text: "Use the weekend window when it comes — no weekday pressure, nothing to change." });
          break;
        case "ExtendFinish": {
          const r = await invoke<RecomputedPlan>("cmd_extend_finish_date", { bookId: props.bookId, addDays: option.add_days });
          setMessage({ tone: "ok", text: `Finish date is now ${r.new_target_finish_date}. ${r.remaining_sections} section${r.remaining_sections === 1 ? "" : "s"} across ${r.remaining_days} day${r.remaining_days === 1 ? "" : "s"}.` });
          await props.onRefresh();
          break;
        }
      }
    } catch {
      // Nothing was changed — say so plainly, in the app's voice, and announce
      // it. The raw error never reaches the reader (FT-39).
      setMessage({ tone: "error", text: "Couldn’t update the plan — nothing changed. Try again in a moment." });
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="tl-recovery">
      <div className="head"><TLIcon name="behind" size={16} /> A little behind — that's alright.</div>
      <div className="lead">
        Behind by {props.bundle.days_behind} day{props.bundle.days_behind === 1 ? "" : "s"}. Pick how to get back in — no catch-up marathon required.
      </div>
      <div className="opts">
        {props.bundle.options.map((o, i) => {
          const d = describeOption(o);
          return (
            <button key={i} className="tl-opt" onClick={() => actOn(o)} disabled={working !== null}>
              <span>
                <span className="t">{working === o.kind ? "…" : d.primary}</span>
                {d.detail && <span className="s">{d.detail}</span>}
              </span>
              <TLIcon name={optionIcon(o)} size={18} />
            </button>
          );
        })}
      </div>
      {message && (
        <p
          className="lead"
          role={message.tone === "error" ? "alert" : undefined}
          style={{
            marginTop: "var(--tl-3)",
            marginBottom: 0,
            color: message.tone === "error" ? "var(--tl-alert)" : "var(--tl-ok)",
          }}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import { errorMessage } from "../types";
import type { Note, SavedNote } from "../types";
import { draftKey as draftKeyFor, parseDraft, quarantineDraft, readRetainedDraft, getDraftGeneration } from "../noteDrafts";

/**
 * One anchored card in a Companion Margin. Shared by the text and EPUB readers.
 * Positioning is the PARENT's job (absolute `top` in the text reader, in-flow in
 * the EPUB rail) — pass it via `style`. User notes autosave the body (debounced
 * cmd_update_note); saved-AI cards render read-only and visually distinct.
 */
export default function MarginNoteCard(props: {
  note: Note;
  active: boolean;
  style?: CSSProperties;
  onActivate: () => void;
  onSaved: () => void;
  onDelete: () => void;
  /** DATA-004: the edit saved durably but its Markdown export failed. */
  onExportIssue?: (noteId: string, message: string) => void;
}) {
  const { note } = props;
  const isAi = note.note_type === "SavedAICard" || note.note_type === "AI" || note.note_type === "TutorNote";
  const isHighlight = note.note_type === "Highlight";
  // DATA-005: the DRAFT is durably retained in localStorage from the first
  // keystroke and cleared only by a CONFIRMED durable save (or the committed
  // delete of its note) — so a rejected save, an unmount mid-debounce, a
  // remount, or a relaunch always comes back to the reader's exact words. The
  // unmount flush is best-effort on top; the retained draft is the guarantee.
  //
  // Each draft records the note `updated_at` it was TYPED AGAINST ("base")
  // plus its bookId. A draft only auto-applies to the same lineage it came
  // from: after a restore-from-backup (or any out-of-band change), the
  // note's updated_at no longer matches, and the stale draft is QUARANTINED
  // (recoverable, never silently erased — R4) instead of resurrecting
  // post-backup words into the restored library. Undo of a staged delete
  // never touches the row, so the base still matches and the reader's words
  // come back with the card.
  const draftKey = draftKeyFor(note.id);
  // Read (and lineage-check) the retained draft ONCE per mount — the lazy
  // initializer keeps its discard-side-effect out of re-renders, where it
  // would wrongly judge a mid-save re-based draft against a stale prop.
  const [initialDraft] = useState(() => readRetainedDraft(note));
  const [body, setBody] = useState(initialDraft ?? note.body);
  const [saving, setSaving] = useState(false);
  // A failed autosave keeps the reader's words and SAYS so (announced), with a
  // real Try again — never a silent catch (DATA-005).
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // The latest body that has NOT durably saved yet, for the unmount flush.
  const pendingRef = useRef<string | null>(initialDraft);
  // The updated_at this editing session is based on. Advanced only by a
  // confirmed save (to the row's new updated_at) — never by a prop refresh,
  // so mid-typing drafts keep pointing at the lineage they extend.
  const baseRef = useRef(note.updated_at);

  // R7-4: while the library generation is UNKNOWN, a value under this note's
  // draft key was deliberately NOT applied (its lineage is undecidable) — the
  // FIRST keystroke of this mount must not overwrite those hidden words.
  // They move to the visible quarantine before anything is written.
  const preservedUnknownRef = useRef(false);
  function preserveUnknownLineageDraft() {
    if (preservedUnknownRef.current) return;
    preservedUnknownRef.current = true;
    if (getDraftGeneration() != null) return;
    const raw = localStorage.getItem(draftKey);
    if (raw == null) return;
    const parsed = parseDraft(raw);
    if ((parsed?.body ?? raw) !== note.body) quarantineDraft(note.id, raw);
  }

  // Reset the editor when this card is reused for a different note — restoring
  // that note's retained draft when one survived a failed/interrupted save.
  useEffect(() => {
    const draft = readRetainedDraft(note);
    setBody(draft ?? note.body);
    pendingRef.current = draft;
    baseRef.current = note.updated_at;
    preservedUnknownRef.current = false;
    /* eslint-disable-next-line */
  }, [note.id]);

  async function saveNow(v: string) {
    setSaving(true);
    try {
      const r = await invoke<SavedNote>("cmd_update_note", { noteId: note.id, body: v });
      if (pendingRef.current === v) pendingRef.current = null;
      // The save moved the row to a new updated_at — later keystrokes extend
      // THAT lineage now.
      baseRef.current = r.note.updated_at;
      const retained = parseDraft(localStorage.getItem(draftKey));
      if (retained?.body === v) {
        // The durable save CONFIRMED — only now may the retained draft go.
        localStorage.removeItem(draftKey);
      } else if (retained != null) {
        // The reader typed MORE while this save was in flight. Re-base that
        // draft onto the new updated_at so a quit right now doesn't discard
        // those words as stale on the next mount.
        localStorage.setItem(draftKey, JSON.stringify({ body: retained.body, base: r.note.updated_at, bookId: note.book_id, ...(getDraftGeneration() != null ? { generation: getDraftGeneration() } : {}) }));
      }
      setSaveErr(null);
      if (!r.export.ok) props.onExportIssue?.(note.id, r.export.message ?? "The Markdown export needs attention.");
      props.onSaved();
    } catch (e) {
      setSaveErr(errorMessage(e)); // local text kept; draft stays retained; Try again below
    } finally {
      setSaving(false);
    }
  }

  function onChange(v: string) {
    setBody(v);
    pendingRef.current = v;
    // R7-4: hidden unknown-lineage words are preserved BEFORE the first write…
    preserveUnknownLineageDraft();
    // …then durable retention FIRST (survives rejection, unmount, remount, relaunch)…
    localStorage.setItem(draftKey, JSON.stringify({ body: v, base: baseRef.current, bookId: note.book_id, ...(getDraftGeneration() != null ? { generation: getDraftGeneration() } : {}) }));
    // …then the debounced durable save that clears it on confirmation.
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void saveNow(v); }, 700);
  }

  // DATA-005: on unmount, ATTEMPT a final flush of a pending debounced edit.
  // Best-effort by nature (the component is gone) — the retained localStorage
  // draft above is what guarantees nothing is lost if this rejects.
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      const pending = pendingRef.current;
      if (pending != null) {
        const key = draftKeyFor(note.id);
        void invoke<SavedNote>("cmd_update_note", { noteId: note.id, body: pending })
          .then((r) => {
            const retained = parseDraft(localStorage.getItem(key));
            if (retained?.body === pending) {
              // R7-5: NOT removed — REBASED onto the row this flush just
              // advanced. A parent that unhides with a STALE row list (the
              // delete-Undo race: unstage → list read → flush commits) would
              // remount this note at its old updated_at; this newer-based
              // draft is what carries the flushed words to that mount
              // instead of letting stale state resurrect and overwrite them.
              // It self-cleans on the first mount that observes the flushed
              // row (body === note.body → redundant → removed).
              localStorage.setItem(key, JSON.stringify({ body: pending, base: r.note.updated_at, bookId: note.book_id, ...(getDraftGeneration() != null ? { generation: getDraftGeneration() } : {}) }));
            } else if (retained != null) {
              // Newer words were typed in another mount mid-flush: re-base
              // them onto the row this flush just advanced.
              localStorage.setItem(key, JSON.stringify({ body: retained.body, base: r.note.updated_at, bookId: note.book_id, ...(getDraftGeneration() != null ? { generation: getDraftGeneration() } : {}) }));
            }
          })
          .catch(() => {
            /* rejected — the retained draft stays for the next mount */
          });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const showEditor = !isAi && (props.active || !isHighlight || body.length > 0);

  // A11Y-010: a card that MOUNTS active (a fresh Note/Question from the
  // selection toolbar, or a marker opened from the keyboard) hands focus to
  // its editor, so the keyboard flow lands where typing happens next.
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (props.active && !isAi) taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`tl-card${isAi ? " ai" : ""}${props.active ? " active" : ""}`}
      style={props.style}
      onClick={props.onActivate}
    >
      <div className="tl-card-head">
        <span className="tl-card-type">{isHighlight ? "Highlight" : isAi ? "AI card" : note.note_type}</span>
        <button className="tl-iconbtn" aria-label="Delete note" onClick={(e) => { e.stopPropagation(); props.onDelete(); }}>
          <TLIcon name="x" size={14} />
        </button>
      </div>
      {note.anchored_text && <blockquote className="tl-card-quote">{note.anchored_text}</blockquote>}
      {isAi ? (
        <p className="tl-card-body">{note.body}</p>
      ) : showEditor ? (
        <textarea
          ref={taRef}
          className="tl-card-input"
          value={body}
          placeholder="Add a thought…"
          onChange={(e) => onChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <p className="tl-card-hint">Click to add a note</p>
      )}
      {saving && <span className="tl-card-saving">Saving…</span>}
      {saveErr && !saving && (
        <p className="tl-card-saveerr" role="alert">
          Couldn't save this note ({saveErr}).{" "}
          <button
            className="tl-tutor-deeper-link"
            onClick={(e) => { e.stopPropagation(); void saveNow(body); }}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import type { Note } from "../types";

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
}) {
  const { note } = props;
  const isAi = note.note_type === "SavedAICard" || note.note_type === "AI" || note.note_type === "TutorNote";
  const isHighlight = note.note_type === "Highlight";
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const timer = useRef<number | null>(null);

  // Reset the editor when this card is reused for a different note.
  useEffect(() => { setBody(note.body); /* eslint-disable-next-line */ }, [note.id]);

  function onChange(v: string) {
    setBody(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setSaving(true);
      try {
        await invoke("cmd_update_note", { noteId: note.id, body: v });
        props.onSaved();
      } catch { /* keep local text; retry on next keystroke */ }
      finally { setSaving(false); }
    }, 700);
  }

  const showEditor = !isAi && (props.active || !isHighlight || body.length > 0);

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
    </div>
  );
}

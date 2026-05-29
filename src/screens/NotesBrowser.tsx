import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RGIcon, { type IconName } from "../components/RGIcon";
import type { Book, Note } from "../types";
import { parseLocator } from "../types";

interface Props {
  book: Book;
}

// Map our five note types onto the design's three badge variants.
function badgeFor(noteType: string): { variant: "note" | "quote" | "question"; icon: IconName } {
  if (noteType === "Short Quote") return { variant: "quote", icon: "quote" };
  if (noteType === "Question") return { variant: "question", icon: "help" };
  return { variant: "note", icon: "note" };
}

function locatorHint(note: Note): string | null {
  if (note.chapter_label) return note.chapter_label;
  const loc = parseLocator(note.locator);
  if (loc.kind === "percent") return `${loc.value}% in`;
  if (loc.kind === "cfi") return "EPUB locator";
  return null;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Read-only browser for the active book's notes. Notes are authored in the
 *  reader and already exported to Markdown; this is a calm review surface. */
export default function NotesBrowser({ book }: Props) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setErr(null);
    invoke<Note[]>("cmd_list_notes", { bookId: book.id })
      .then((list) => { if (!cancelled) setNotes(list); })
      .catch((e: any) => { if (!cancelled) setErr(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [book.id]);

  return (
    <div className="rg-col rg-notes">
      <div className="rg-notes-head">
        <h2>Notes</h2>
        {notes && notes.length > 0 && <span className="count">{notes.length} from this book</span>}
      </div>

      {err && <p className="rg-note-meta" style={{ color: "var(--rg-alert)" }}>{err}</p>}
      {notes === null && !err && <p className="rg-note-meta">Loading…</p>}
      {notes && notes.length === 0 && (
        <p className="rg-note-meta">No notes yet for this book. Capture one while reading — it exports to Markdown automatically.</p>
      )}

      {notes?.map((n) => {
        const b = badgeFor(n.note_type);
        const hint = locatorHint(n);
        return (
          <article className="rg-note" key={n.id}>
            <div className="rg-note-top">
              <span className={`rg-badge ${b.variant}`}>
                <RGIcon name={b.icon} size={12} /> {n.note_type}
              </span>
              <span className="rg-note-meta">
                {hint && <>{hint}<span className="sep">·</span></>}{fmtDate(n.created_at)}
              </span>
            </div>
            <div className="rg-note-body">{n.body}</div>
            {n.short_quote && <blockquote>“{n.short_quote}”</blockquote>}
          </article>
        );
      })}
    </div>
  );
}

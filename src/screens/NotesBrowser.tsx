import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Book, Note } from "../types";
import { parseLocator } from "../types";

interface Props {
  book: Book;
}

/** Human-readable position hint for a note. Prefer the chapter label; fall back
 *  to a percentage; never show a raw char offset (meaningless to a reader). */
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

/**
 * Read-only browser for the active book's notes (the "Notes" tab on the book
 * page). Notes are authored in the reader and already exported to Markdown;
 * this is a calm review surface, not an editor — no scope beyond listing.
 */
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
    <section className="screen">
      <div className="card notes-card">
        <div className="kicker">Notes — {book.title}</div>

        {err && <p className="settings-err">{err}</p>}
        {notes === null && !err && <p className="muted">Loading…</p>}

        {notes && notes.length === 0 && (
          <p className="muted notes-empty">
            No notes yet for this book. Capture one while reading — it exports to
            Markdown automatically.
          </p>
        )}

        {notes && notes.length > 0 && (
          <>
            <p className="muted small">
              {notes.length} note{notes.length === 1 ? "" : "s"}, newest first.
            </p>
            <ul className="notes-list">
              {notes.map((n) => {
                const hint = locatorHint(n);
                return (
                  <li key={n.id} className="note-row">
                    <div className="note-meta">
                      <span className="note-type">{n.note_type}</span>
                      {hint && <span className="note-locator muted small">{hint}</span>}
                      <span className="note-date muted small">{fmtDate(n.created_at)}</span>
                    </div>
                    <p className="note-body">{n.body}</p>
                    {n.short_quote && (
                      <blockquote className="note-quote">{n.short_quote}</blockquote>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

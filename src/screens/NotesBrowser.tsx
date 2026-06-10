import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon, { type IconName } from "../components/TLIcon";
import type { Book, Note } from "../types";
import { locatorHint } from "../locatorHint";

interface Props {
  book: Book;
}

// Notebook categories. Each note maps to exactly one, derived from note_type.
type Category = "highlight" | "note" | "question" | "takeaway" | "tutor";

function categoryOf(noteType: string): Category {
  if (noteType === "Highlight") return "highlight";
  if (noteType === "Question") return "question";
  if (noteType === "Takeaway") return "takeaway";
  if (noteType === "TutorNote" || noteType === "SavedAICard" || noteType === "AI") return "tutor";
  return "note"; // MarginNote, Observation, Connection, Reflection, Short Quote
}

const CATEGORY_META: Record<Category, { label: string }> = {
  highlight: { label: "Highlights" },
  note: { label: "Notes" },
  question: { label: "Questions" },
  takeaway: { label: "Takeaways" },
  tutor: { label: "Tutor cards" },
};
const CATEGORY_ORDER: Category[] = ["highlight", "note", "question", "takeaway", "tutor"];

function badgeFor(noteType: string): { variant: "note" | "quote" | "question"; icon: IconName } {
  if (noteType === "Short Quote") return { variant: "quote", icon: "quote" };
  if (noteType === "Question") return { variant: "question", icon: "help" };
  return { variant: "note", icon: "note" };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function displayType(noteType: string): string {
  return noteType === "MarginNote" ? "Note" : noteType;
}

const UNFILED = "Unfiled";

/**
 * Chapter notebook — a calm review surface for everything the reader captured,
 * grouped by chapter and filterable by category (Highlights / Notes / Questions
 * / Takeaways / Tutor cards). Creation stays in the reader/margin; this is
 * review only. Notes already export to Markdown on save (stable filenames, so
 * re-export updates rather than duplicates) — nothing here re-writes them.
 */
export default function NotesBrowser({ book }: Props) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Category | "all">("all");

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setErr(null);
    setFilter("all");
    invoke<Note[]>("cmd_list_notes", { bookId: book.id })
      .then((list) => { if (!cancelled) setNotes(list); })
      .catch((e: any) => { if (!cancelled) setErr(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [book.id]);

  // Per-category counts for the filter chips.
  const counts = useMemo(() => {
    const c: Record<Category, number> = { highlight: 0, note: 0, question: 0, takeaway: 0, tutor: 0 };
    for (const n of notes ?? []) c[categoryOf(n.note_type)] += 1;
    return c;
  }, [notes]);

  // Notes after the category filter, grouped by chapter. Notes arrive
  // newest-first; we keep that order within a chapter, and chapters appear in
  // order of first (most recent) activity so re-entry lands on recent work.
  const groups = useMemo(() => {
    const filtered = (notes ?? []).filter((n) => filter === "all" || categoryOf(n.note_type) === filter);
    const byChapter = new Map<string, Note[]>();
    for (const n of filtered) {
      const key = n.chapter_label?.trim() || UNFILED;
      const arr = byChapter.get(key);
      if (arr) arr.push(n);
      else byChapter.set(key, [n]);
    }
    return Array.from(byChapter.entries());
  }, [notes, filter]);

  const total = notes?.length ?? 0;

  return (
    <div className="tl-col tl-notes">
      <div className="tl-notes-head">
        <h2>Notebook</h2>
        {total > 0 && <span className="count">{total} from this book</span>}
      </div>

      {err && <p className="tl-note-meta" style={{ color: "var(--tl-alert)" }}>{err}</p>}
      {notes === null && !err && <p className="tl-note-meta">Loading…</p>}
      {notes && total === 0 && (
        <p className="tl-note-meta">Nothing captured yet for this book. Highlight a line, write a note, mark a question, or save a takeaway while reading — it collects here and exports to Markdown automatically.</p>
      )}

      {total > 0 && (
        <div className="tl-notebook-filters" role="group" aria-label="Filter notes by type">
          <button className={filter === "all" ? "tl-typetag is-active" : "tl-typetag"} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All · {total}</button>
          {CATEGORY_ORDER.filter((c) => counts[c] > 0).map((c) => (
            <button key={c} className={filter === c ? "tl-typetag is-active" : "tl-typetag"} aria-pressed={filter === c} onClick={() => setFilter(c)}>
              {CATEGORY_META[c].label} · {counts[c]}
            </button>
          ))}
        </div>
      )}

      {groups.map(([chapter, chapterNotes]) => (
        <section className="tl-notebook-chapter" key={chapter}>
          <h3 className="tl-notebook-chapter-h">{chapter}</h3>
          {chapterNotes.map((n) => {
            const b = badgeFor(n.note_type);
            const hint = locatorHint(n.locator);
            return (
              <article className="tl-note" key={n.id}>
                <div className="tl-note-top">
                  <span className={`tl-badge ${b.variant}`}>
                    <TLIcon name={b.icon} size={12} /> {displayType(n.note_type)}
                  </span>
                  <span className="tl-note-meta">
                    {hint && <>{hint}<span className="sep">·</span></>}{fmtDate(n.created_at)}
                  </span>
                </div>
                {n.body.trim() ? (
                  <div className="tl-note-body">{n.body}</div>
                ) : n.anchored_text ? (
                  <blockquote className="tl-note-anchored">“{n.anchored_text}”</blockquote>
                ) : null}
                {n.short_quote && <blockquote>“{n.short_quote}”</blockquote>}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

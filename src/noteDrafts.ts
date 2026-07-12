// DATA-005 R4: retained note drafts and their QUARANTINE.
//
// A draft records the exact row state it was typed against ({ body, base:
// note.updated_at, bookId }). A draft may auto-apply ONLY to that same
// lineage. Anything else — a restored-from-backup row, a legacy value with no
// lineage, an orphan whose note was deleted by the quit-time sweep — must not
// auto-apply, but the reader's words are NEVER silently erased either: the
// value moves to a quarantine key (`tl.noteDraftQuarantine.…`), where it stays
// recoverable instead of overwriting a restored library or vanishing.
import type { Note } from "./types";

export const DRAFT_PREFIX = "tl.noteDraft.";
export const QUARANTINE_PREFIX = "tl.noteDraftQuarantine.";

/** A retained draft plus the note lineage it was typed against. `bookId` is
 *  carried so startup reconciliation can check the note still exists;
 *  `generation` is the LIBRARY GENERATION token (R5) the draft was typed
 *  under — rotated by every restore/undo/recovery, so a draft can never
 *  auto-apply across a library replacement even when a restored row's
 *  updated_at coincidentally matches. */
export type NoteDraft = { body: string; base: string; bookId?: string; generation?: string };

// R5/R6: the current library generation, loaded from cmd_get_settings at
// startup (before reconciliation runs). `null` = not yet known — and unknown
// lineage NEVER auto-applies a draft (R6-4): the reader could be shown stale
// words as current. Unknown also never destroys: the value stays put,
// unapplied, until a launch that KNOWS the generation decides.
let currentGeneration: string | null = null;

export function setDraftGeneration(g: string | null): void {
  currentGeneration = g;
}

export function getDraftGeneration(): string | null {
  return currentGeneration;
}

/** True iff `draft` provably belongs to the current library generation.
 *  An UNKNOWN current generation matches nothing (R6-4) — callers handle
 *  unknown fail-closed (no apply, no quarantine) before deciding anything. */
function generationMatches(draft: NoteDraft): boolean {
  if (currentGeneration == null) return false;
  return (draft.generation ?? "") === currentGeneration;
}

export function draftKey(noteId: string): string {
  return `${DRAFT_PREFIX}${noteId}`;
}

export function parseDraft(raw: string | null): NoteDraft | null {
  if (raw == null) return null;
  try {
    const d = JSON.parse(raw) as Partial<NoteDraft> | null;
    if (d && typeof d.body === "string" && typeof d.base === "string") {
      return {
        body: d.body,
        base: d.base,
        ...(typeof d.bookId === "string" ? { bookId: d.bookId } : {}),
        ...(typeof d.generation === "string" ? { generation: d.generation } : {}),
      };
    }
  } catch {
    /* not a draft */
  }
  return null;
}

/** Move a draft value into quarantine (recoverable, never auto-applied).
 *  The quarantine key embeds the note id and a uniqueness counter so repeated
 *  quarantines never overwrite earlier words. */
export function quarantineDraft(noteId: string, raw: string): void {
  let n = 0;
  let key = `${QUARANTINE_PREFIX}${noteId}`;
  while (localStorage.getItem(key) != null && localStorage.getItem(key) !== raw) {
    n += 1;
    key = `${QUARANTINE_PREFIX}${noteId}.${n}`;
  }
  localStorage.setItem(key, raw);
  localStorage.removeItem(draftKey(noteId));
}

/** The note's retained draft, iff it belongs to THIS row lineage
 *  (draft.base === note.updated_at) and still differs from the saved body.
 *  A redundant draft (identical to the saved body) is simply removed; a
 *  MISMATCHED or unparseable one is QUARANTINED — the reader's words stay
 *  recoverable, they just never resurrect onto a restored row (R4). */
export function readRetainedDraft(note: Note): string | null {
  const key = draftKey(note.id);
  const raw = localStorage.getItem(key);
  if (raw == null) return null;
  // R6-4: lineage UNKNOWN (settings not loaded / load failed) — never
  // auto-apply, never quarantine, never remove. The words stay exactly where
  // they are until a pass that knows the generation can decide.
  if (currentGeneration == null) return null;
  const draft = parseDraft(raw);
  if (
    draft != null &&
    generationMatches(draft) &&
    draft.base === note.updated_at &&
    draft.body !== note.body
  ) {
    return draft.body;
  }
  if (draft != null && draft.body === note.body) {
    localStorage.removeItem(key); // identical to the saved row — nothing to keep
    return null;
  }
  const draftBase = draft != null ? Date.parse(draft.base) : Number.NaN;
  const rowBase = Date.parse(note.updated_at);
  if (
    draft != null &&
    generationMatches(draft) &&
    Number.isFinite(draftBase) &&
    Number.isFinite(rowBase) &&
    draftBase > rowBase
  ) {
    // R7-5: the draft records a DURABLE save the caller's row list has not
    // caught up to (an unmount flush landed after the list was read — the
    // delete-Undo race). Same library generation, strictly NEWER lineage
    // (both bases parse as real instants): these are the flushed words. Show
    // them and RETAIN the record until a mount observes the caught-up row
    // (where body === note.body removes it as redundant).
    return draft.body;
  }
  quarantineDraft(note.id, raw);
  return null;
}

/** Startup reconciliation (R4): quarantine every retained draft whose note no
 *  longer exists — a deletion the quit-time sweep committed in Rust leaves the
 *  frontend's draft orphaned, and a LATER restore could bring the note id back
 *  with a matching updated_at, silently resurrecting deleted words. Drafts
 *  with no bookId (legacy) can't be verified and are quarantined too. A failed
 *  lookup leaves that book's drafts untouched (never destroy on uncertainty). */
export async function reconcileNoteDrafts(
  listNotes: (bookId: string) => Promise<Array<{ id: string }>>,
): Promise<void> {
  const entries: Array<{ noteId: string; draft: NoteDraft | null; raw: string }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    entries.push({ noteId: key.slice(DRAFT_PREFIX.length), draft: parseDraft(raw), raw });
  }

  const byBook = new Map<string, Array<{ noteId: string; raw: string }>>();
  for (const e of entries) {
    if (e.draft?.bookId == null) {
      quarantineDraft(e.noteId, e.raw); // unverifiable lineage
      continue;
    }
    if (currentGeneration != null && !generationMatches(e.draft)) {
      // R5: typed under a DIFFERENT library generation (a restore/undo/
      // recovery happened since) — never auto-apply across a replacement,
      // even when the restored row's updated_at coincidentally matches.
      // (R6-4: with the generation UNKNOWN this decision is deferred, not
      // taken — the draft stays put and stays unapplied.)
      quarantineDraft(e.noteId, e.raw);
      continue;
    }
    const list = byBook.get(e.draft.bookId) ?? [];
    list.push({ noteId: e.noteId, raw: e.raw });
    byBook.set(e.draft.bookId, list);
  }

  for (const [bookId, drafts] of byBook) {
    let ids: Set<string>;
    try {
      ids = new Set((await listNotes(bookId)).map((n) => n.id));
    } catch {
      continue; // uncertainty is not license to destroy — keep the drafts
    }
    for (const d of drafts) {
      if (!ids.has(d.noteId)) quarantineDraft(d.noteId, d.raw);
    }
  }
}

/** One quarantined draft, for the reader-visible recovery surface (R5). */
export type QuarantinedDraft = {
  key: string;
  noteId: string;
  body: string;
  bookId: string | null;
};

/** Every quarantined draft currently held (raw non-draft values included —
 *  their bytes are the reader's words too). */
export function listQuarantinedDrafts(): QuarantinedDraft[] {
  const out: QuarantinedDraft[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(QUARANTINE_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    const draft = parseDraft(raw);
    // The quarantine key is `${prefix}${noteId}` or `${prefix}${noteId}.N`.
    const noteId = key.slice(QUARANTINE_PREFIX.length).replace(/\.\d+$/, "");
    out.push({
      key,
      noteId,
      body: draft?.body ?? raw,
      bookId: draft?.bookId ?? null,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function discardQuarantinedDraft(key: string): void {
  localStorage.removeItem(key);
}

/** Put a quarantined draft back as the ACTIVE retained draft for its note,
 *  rebased onto the note's CURRENT lineage and the CURRENT library generation
 *  — an explicit reader decision, so the rebase is deliberate, not silent.
 *  The next card mount applies it (it differs from the saved body).
 *
 *  R6-5: put back is lossless in BOTH directions — if the note already holds
 *  an active retained draft with different words, that value is preserved as
 *  another quarantine entry first, never overwritten. */
export function restoreQuarantinedDraft(key: string, note: Note): void {
  const raw = localStorage.getItem(key);
  if (raw == null) return;
  const draft = parseDraft(raw);
  const body = draft?.body ?? raw;
  const activeRaw = localStorage.getItem(draftKey(note.id));
  if (activeRaw != null) {
    const active = parseDraft(activeRaw);
    if ((active?.body ?? activeRaw) !== body) {
      // The occupied words move aside into their own quarantine slot (the
      // collision-proof walk lands them beside, never over, this entry).
      quarantineDraft(note.id, activeRaw);
    }
  }
  localStorage.setItem(
    draftKey(note.id),
    JSON.stringify({
      body,
      base: note.updated_at,
      bookId: note.book_id,
      ...(currentGeneration != null ? { generation: currentGeneration } : {}),
    }),
  );
  localStorage.removeItem(key);
}

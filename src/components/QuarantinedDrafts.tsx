import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  draftKey,
  listQuarantinedDrafts,
  discardQuarantinedDraft,
  parseDraft,
  restoreQuarantinedDraft,
  type QuarantinedDraft,
} from "../noteDrafts";
import type { Book, Note } from "../types";

/**
 * R5: the reader-VISIBLE recovery surface for quarantined note drafts.
 * Quarantine holds words that could not safely auto-apply (a restore/undo
 * replaced the library, a note was deleted by the launch sweep, a legacy
 * value had no lineage). Hidden localStorage bytes are not "recoverable" —
 * this list is. Each entry offers:
 *
 *  - **Put back**: rebase the words onto the note's CURRENT state as its
 *    active draft (only when the note still exists) — an explicit reader
 *    decision, so the rebase is deliberate;
 *  - **Copy**: the words onto the clipboard;
 *  - **Discard**: let them go (the ONLY way quarantined words are erased).
 *
 * Rendered in Settings › Files, only when something is actually held.
 */
export default function QuarantinedDrafts() {
  const [entries, setEntries] = useState<QuarantinedDraft[]>(() => listQuarantinedDrafts());
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<string | null>(null);
  // R6-5: entries whose FULL text is shown (a failed clipboard copy must
  // leave the reader with the complete selectable words, not a 120-char
  // preview of them).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (entries.length === 0) return;
    void invoke<Book[]>("cmd_list_books")
      .then((books) => setTitles(new Map(books.map((b) => [b.id, b.title]))))
      .catch(() => {
        /* titles are a nicety; the words still show */
      });
  }, [entries.length]);

  // Keep rendering while a status line is up (e.g. "Put back." after the
  // last entry was consumed) — the confirmation must not vanish mid-read.
  if (entries.length === 0 && !status) return null;

  const refresh = () => setEntries(listQuarantinedDrafts());

  async function putBack(entry: QuarantinedDraft) {
    if (!entry.bookId) {
      setStatus("This draft doesn't record its book — use Copy to keep the words.");
      return;
    }
    let note: Note | undefined;
    try {
      const notes = await invoke<Note[]>("cmd_list_notes", { bookId: entry.bookId });
      note = notes.find((n) => n.id === entry.noteId);
    } catch {
      setStatus("Couldn't check the note right now — try again, or use Copy.");
      return;
    }
    if (!note) {
      setStatus("That note no longer exists — use Copy to keep the words, or Discard.");
      return;
    }
    // R6-5: put back never overwrites — if the note already holds a DIFFERENT
    // active draft, the storage layer quarantines those words beside this
    // list, and the confirmation says so.
    const activeRaw = localStorage.getItem(draftKey(entry.noteId));
    const displaced =
      activeRaw != null && (parseDraft(activeRaw)?.body ?? activeRaw) !== entry.body;
    restoreQuarantinedDraft(entry.key, note);
    setStatus(
      displaced
        ? "Put back. The note's other draft was kept safe in this list instead of being overwritten."
        : "Put back. The draft will be waiting on that note's card.",
    );
    refresh();
  }

  async function copyWords(entry: QuarantinedDraft) {
    try {
      await navigator.clipboard.writeText(entry.body);
      setStatus("Copied.");
    } catch {
      // R6-5: "select and copy directly" must be genuinely possible — show
      // the COMPLETE text, not the truncated preview.
      setExpanded((cur) => new Set(cur).add(entry.key));
      setStatus(
        "Couldn't reach the clipboard — the full draft is shown below; select and copy it directly.",
      );
    }
  }

  function discard(entry: QuarantinedDraft) {
    discardQuarantinedDraft(entry.key);
    setStatus("Discarded.");
    refresh();
  }

  return (
    <div className="set-row set-row-stack" data-testid="quarantined-drafts">
      <div className="set-row-top">
        <div className="set-row-label">
          Recovered note drafts{" "}
          <span className="set-row-detail">· words kept safe when they couldn't be applied</span>
        </div>
      </div>
      <p className="set-row-explain">
        These are note edits Throughline set aside instead of applying them automatically —
        usually after a backup was restored, or a note was removed. Nothing here is deleted
        until you decide.
      </p>
      {status && (
        <p className="set-msg ok" role="status">
          {status}
        </p>
      )}
      <ul className="set-quarantine-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {entries.map((e) => (
          <li key={e.key} style={{ padding: "4px 0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="set-row-detail">
                  {e.bookId ? (titles.get(e.bookId) ?? "A removed book") : "Unknown book"} ·{" "}
                </span>
                <span style={{ overflowWrap: "anywhere" }}>
                  {e.body.length > 120 ? `${e.body.slice(0, 120)}…` : e.body}
                </span>
              </span>
              <button type="button" className="btn btn-small" onClick={() => void putBack(e)}>
                Put back
              </button>
              <button type="button" className="btn btn-small" onClick={() => void copyWords(e)}>
                Copy
              </button>
              <button type="button" className="btn btn-small" onClick={() => discard(e)}>
                Discard
              </button>
            </div>
            {expanded.has(e.key) && (
              <textarea
                readOnly
                value={e.body}
                aria-label="Full draft text — select and copy"
                rows={Math.min(10, Math.max(3, Math.ceil(e.body.length / 60)))}
                style={{ width: "100%", marginTop: 4, resize: "vertical" }}
                onFocus={(ev) => ev.currentTarget.select()}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

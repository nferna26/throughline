import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import AiPanel from "./AiPanel";
import RGIcon from "../components/RGIcon";
import MarginNoteCard from "../components/MarginNoteCard";
import { useDialog } from "../hooks/useDialog";
import type { BookSection, Note, ReadingSession, TodayCard, ReaderMode } from "../types";
import { NOTE_TYPES, makeCharLocator, parseLocator } from "../types";

interface Props {
  today: TodayCard;
  mode?: ReaderMode;
  onExit: () => void;
}

/**
 * Text reader. One session can span many sections via Next › / ‹ Prev.
 * Section completion is derived from "did the reader advance past this section
 * during this sitting?" — no manual mark-complete gate.
 */
export default function TextReader({ today, mode = "full", onExit }: Props) {
  const { book, section: assignedSection } = today;
  const rescue = mode === "rescue";
  // CANONICAL READING SEQUENCE: only sections marked assignable. Front/back
  // matter is filtered out by the backend (`cmd_assignable_sections`) and is
  // NEVER reachable through reader navigation. Initial position, Next/Prev,
  // and completion-tracking all index into this list.
  const [assignableSections, setAssignableSections] = useState<BookSection[]>([]);
  const [currentIdx, setCurrentIdx] = useState<number>(-1);
  const [text, setText] = useState<string>("");
  const [paragraphs, setParagraphs] = useState<Array<{ offset: number; text: string }>>([]);
  const [session, setSession] = useState<ReadingSession | null>(null);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [fontSize, setFontSize] = useState<number>(
    () => parseInt(localStorage.getItem("rg.fontSize") || "18", 10)
  );
  const [lineWidth, setLineWidth] = useState<number>(
    () => parseInt(localStorage.getItem("rg.lineWidth") || "640", 10)
  );
  const [showNote, setShowNote] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [selection, setSelection] = useState<string>("");
  const [topOffset, setTopOffset] = useState<number>(0);
  const startedAt = useRef<number>(Date.now());
  const [endingPrompt, setEndingPrompt] = useState(false);
  const [summary, setSummary] = useState("");
  // ── Companion Margin: anchored notes/highlights beside the text ──
  const [notes, setNotes] = useState<Note[]>([]);
  const [sel, setSel] = useState<{ x: number; y: number; start: number; end: number; text: string } | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [cardTops, setCardTops] = useState<Record<string, number>>({});
  const readerRef = useRef<HTMLElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);

  const refreshNotes = useCallback(async () => {
    try {
      const all = await invoke<Note[]>("cmd_list_notes", { bookId: book.id });
      setNotes(all);
    } catch { /* notes are non-critical to reading */ }
  }, [book.id]);
  useEffect(() => { refreshNotes(); }, [refreshNotes]);

  useEffect(() => { localStorage.setItem("rg.fontSize", String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem("rg.lineWidth", String(lineWidth)); }, [lineWidth]);

  // Load section list and start the session ONCE per reader open.
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!assignedSection) return;
      const list = await invoke<BookSection[]>("cmd_assignable_sections", { bookId: book.id });
      if (cancelled) return;
      setAssignableSections(list);
      // Find the assigned section in the assignable list. If it isn't there for
      // any reason (data drift), fall back to the first assignable item — but
      // never to an arbitrary spine entry.
      const fromAssigned = list.findIndex((s) => s.id === assignedSection.id);
      const startIdx = fromAssigned >= 0 ? fromAssigned : 0;
      setCurrentIdx(startIdx);
      const baseOffset = parseInt(list[startIdx]?.start_locator || "0", 10);
      const startLoc = today.resume_locator ?? makeCharLocator(baseOffset);
      const s = await invoke<ReadingSession>("cmd_start_session", {
        bookId: book.id,
        sectionId: list[startIdx]?.id ?? assignedSection.id,
        startLocator: startLoc,
      });
      if (cancelled) return;
      setSession(s);
      startedAt.current = Date.now();
    }
    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, assignedSection?.id]);

  // Load the current section's text whenever currentIdx changes.
  useEffect(() => {
    let cancelled = false;
    async function loadSection() {
      const sec = assignableSections[currentIdx];
      if (!sec) return;
      const t = await invoke<string>("cmd_read_section_text", {
        bookId: book.id,
        sectionId: sec.id,
      });
      if (cancelled) return;
      setText(t);
      setParagraphs(splitParagraphs(t));
      // Mark the section as visited
      setVisited((prev) => {
        if (prev.has(sec.id)) return prev;
        const next = new Set(prev);
        next.add(sec.id);
        return next;
      });
      // Resume to saved char offset only for the section we originally landed on.
      if (sec.id === assignedSection?.id && today.resume_locator) {
        const baseOffset = parseInt(sec.start_locator || "0", 10);
        const parsed = parseLocator(today.resume_locator);
        if (parsed.kind === "char") {
          const abs = parseInt(parsed.value, 10);
          const within = Math.max(0, abs - baseOffset);
          setTopOffset(within);
          setTimeout(() => scrollToOffset(within), 30);
        }
      } else {
        setTopOffset(0);
        if (containerRef.current) containerRef.current.scrollTop = 0;
      }
    }
    loadSection();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, assignableSections.length]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const paragraphRefs = useRef<Map<number, HTMLParagraphElement>>(new Map());

  function scrollToOffset(within: number) {
    if (!containerRef.current) return;
    let best: HTMLParagraphElement | null = null;
    let bestOffset = -1;
    for (const [off, el] of paragraphRefs.current.entries()) {
      if (off <= within && off > bestOffset) {
        bestOffset = off;
        best = el;
      }
    }
    if (best) {
      const c = containerRef.current;
      const target = best.offsetTop - 40;
      c.scrollTop = Math.max(0, target);
    }
  }

  function handleScroll() {
    if (!containerRef.current) return;
    const scrollTop = containerRef.current.scrollTop;
    let best: { off: number; top: number } | null = null;
    for (const [off, el] of paragraphRefs.current.entries()) {
      const top = el.offsetTop;
      if (top <= scrollTop + 60) {
        if (!best || top > best.top) {
          best = { off, top };
        }
      }
    }
    const off = best ? best.off : 0;
    setTopOffset(off);
    const sec = assignableSections[currentIdx];
    if (sec) {
      const baseOffset = parseInt(sec.start_locator || "0", 10);
      const total = (sec.estimated_units || text.length) || 1;
      const pct = Math.min(100, Math.max(0, (off / total) * 100));
      const locator = makeCharLocator(baseOffset + off);
      throttledSaveProgress(book.id, sec.id, locator, pct);
    }
  }

  const locator = useMemo(() => {
    const sec = assignableSections[currentIdx];
    if (!sec) return makeCharLocator(0);
    const base = parseInt(sec.start_locator || "0", 10);
    return makeCharLocator(base + topOffset);
  }, [assignableSections, currentIdx, topOffset]);

  const goNext = useCallback(() => {
    setCurrentIdx((i) => Math.min(assignableSections.length - 1, i + 1));
  }, [assignableSections.length]);

  const goPrev = useCallback(() => {
    setCurrentIdx((i) => Math.max(0, i - 1));
  }, []);

  async function finalizeSession() {
    if (!session) return onExit();
    const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000));
    // Sections crossed are those visited that we have moved past (i.e. not the current one
    // unless the user scrolled to the very end). For simplicity, count all visited sections
    // *except* the current one if it's the last visited and we haven't reached its end.
    const sec = assignableSections[currentIdx];
    const completed: string[] = [];
    for (const v of visited) {
      if (v !== sec?.id) {
        completed.push(v);
      }
    }
    // Include the current section if scroll reached >= 95% of its length.
    if (sec) {
      const total = sec.estimated_units || text.length || 1;
      if (topOffset / total >= 0.95) completed.push(sec.id);
    }
    await invoke<ReadingSession>("cmd_end_session", {
      sessionId: session.id,
      endLocator: locator,
      minutes,
      completedSectionIds: completed,
      summarySentence: summary.trim() || null,
    });
    onExit();
  }

  const targetSection = assignedSection;
  const currentSection = assignableSections[currentIdx];

  // Section char range, used to scope notes and to map absolute book locators
  // back to within-section offsets for highlight rendering.
  const secBase = parseInt(currentSection?.start_locator || "0", 10);
  const secEnd = parseInt(currentSection?.end_locator || String(secBase + text.length), 10);

  // Notes anchored inside the current section. Prefer the char anchor (precise);
  // fall back to chapter label for notes saved without one.
  const sectionNotes = useMemo(() => {
    return notes
      .filter((n) => {
        const p = parseLocator(n.anchor_start || n.locator);
        if (p.kind === "char") {
          const v = parseInt(p.value, 10);
          return v >= secBase && v < secEnd;
        }
        return n.chapter_label != null && n.chapter_label === currentSection?.label;
      })
      .sort((a, b) => anchorChar(a) - anchorChar(b));
  }, [notes, secBase, secEnd, currentSection?.label]);

  // Highlights to paint inline, grouped by within-section char span.
  const highlights = useMemo(() => {
    return sectionNotes
      .map((n) => {
        const p = parseLocator(n.anchor_start || n.locator);
        if (p.kind !== "char" || !n.anchored_text) return null;
        const start = parseInt(p.value, 10) - secBase;
        return { id: n.id, start, end: start + n.anchored_text.length };
      })
      .filter((h): h is { id: string; start: number; end: number } => h != null && h.start >= 0);
  }, [sectionNotes, secBase]);

  // Position each margin card at the top of its anchored paragraph, then nudge
  // apart any that would overlap. Recomputes on reflow (font/width/notes/text).
  useEffect(() => {
    const col = colRef.current;
    if (!col) return;
    const order = sectionNotes.map((n) => {
      const within = anchorChar(n) - secBase;
      let best: HTMLElement | null = null;
      let bestOff = -1;
      for (const [off, el] of paragraphRefs.current.entries()) {
        if (off <= within && off > bestOff) { bestOff = off; best = el; }
      }
      return { id: n.id, top: best ? best.offsetTop : 0 };
    });
    order.sort((a, b) => a.top - b.top);
    const MIN_GAP = 92;
    let last = -Infinity;
    const tops: Record<string, number> = {};
    for (const o of order) {
      const t = Math.max(o.top, last + MIN_GAP);
      tops[o.id] = t;
      last = t;
    }
    setCardTops(tops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionNotes, paragraphs, fontSize, lineWidth, text, secBase]);

  // Capture a selection inside the reading column → show the action toolbar.
  function onTextMouseUp() {
    const s = window.getSelection?.();
    if (!s || s.isCollapsed || s.rangeCount === 0) { setSel(null); return; }
    const range = s.getRangeAt(0);
    const col = colRef.current;
    const reader = readerRef.current;
    if (!col || !reader || !col.contains(range.commonAncestorContainer)) { setSel(null); return; }
    const text = s.toString();
    if (text.trim().length < 1) { setSel(null); return; }
    const start = charOffsetWithinSection(range.startContainer, range.startOffset, col);
    const end = charOffsetWithinSection(range.endContainer, range.endOffset, col);
    if (start == null || end == null) { setSel(null); return; }
    const rect = range.getBoundingClientRect();
    const rRect = reader.getBoundingClientRect();
    setSel({
      x: rect.left - rRect.left + rect.width / 2,
      y: rect.top - rRect.top,
      start: secBase + Math.min(start, end),
      end: secBase + Math.max(start, end),
      text,
    });
  }

  async function createAnchoredNote(noteType: string): Promise<Note | null> {
    if (!sel) return null;
    try {
      const note = await invoke<Note>("cmd_save_note", {
        bookId: book.id,
        sessionId: session?.id ?? null,
        noteType,
        locator: makeCharLocator(sel.start),
        chapterLabel: currentSection?.label ?? null,
        body: "",
        shortQuote: null,
        anchorStart: makeCharLocator(sel.start),
        anchorEnd: makeCharLocator(sel.end),
        anchoredText: sel.text,
      });
      window.getSelection?.()?.removeAllRanges();
      setSel(null);
      await refreshNotes();
      return note;
    } catch {
      setSel(null);
      return null;
    }
  }

  async function onHighlight() { await createAnchoredNote("Highlight"); }
  async function onMarginNote() {
    const n = await createAnchoredNote("MarginNote");
    if (n) setActiveNoteId(n.id);
  }
  function onExplainSelection() {
    if (sel && sel.text.trim().length >= 4) setSelection(sel.text);
    setSel(null);
    setShowAi(true);
  }
  async function deleteNote(id: string) {
    try { await invoke("cmd_delete_note", { noteId: id }); } catch { /* ignore */ }
    if (activeNoteId === id) setActiveNoteId(null);
    await refreshNotes();
  }

  if (!currentSection) {
    return (
      <div className="rg-reader">
        <div className="rg-readscroll"><div className="rg-readcol"><p>No section to read.</p>
          <button className="rg-btn rg-btn-ghost" onClick={onExit}>Back</button></div></div>
      </div>
    );
  }

  return (
    <section className="rg-reader" ref={readerRef}>
      <div className="rg-readtoolbar">
        <button className="rg-back" onClick={onExit}><RGIcon name="chevronLeft" size={18} /> Today</button>
        <span className="rg-tb-title">
          {currentSection.label}
          {targetSection && targetSection.id !== currentSection.id && ` · today: ${targetSection.label}`}
        </span>
        <div className="spacer" />
        <div className="grp bordered" role="group" aria-label="Font size">
          <button className="rg-iconbtn" aria-label="Smaller text" onClick={() => setFontSize((f) => Math.max(12, f - 1))}><RGIcon name="minus" size={16} /></button>
          <span className="rg-tb-label"><RGIcon name="type" size={16} /></span>
          <button className="rg-iconbtn" aria-label="Larger text" onClick={() => setFontSize((f) => Math.min(28, f + 1))}><RGIcon name="plus" size={16} /></button>
        </div>
        <div className="grp bordered" role="group" aria-label="Line width">
          {[520, 640, 760].map((w, i) => (
            <button
              key={w}
              className={lineWidth === w ? "rg-iconbtn active" : "rg-iconbtn"}
              aria-pressed={lineWidth === w}
              aria-label={`Line width ${["narrow", "medium", "wide"][i]}`}
              style={{ width: 26 }}
              onClick={() => setLineWidth(w)}
            >
              <span style={{ display: "block", height: 2, borderRadius: 2, background: "currentColor", width: [9, 13, 17][i] }} />
            </button>
          ))}
        </div>
        <div className="rg-tb-div" />
        <button className={showNote ? "rg-iconbtn active" : "rg-iconbtn"} aria-label="Add note" title="Add note" onClick={() => setShowNote(true)}><RGIcon name="pencil" size={18} /></button>
        <button
          className={showAi ? "rg-iconbtn active" : "rg-iconbtn"}
          aria-label="Explain passage"
          title="Tutor (prompt preview only — no remote call)"
          onClick={() => {
            const sel = window.getSelection?.()?.toString?.() ?? "";
            if (sel.trim().length >= 4) setSelection(sel);
            setShowAi(true);
          }}
        >
          <RGIcon name="sparkle" size={18} />
        </button>
        <div className="rg-tb-div" />
        <button className="rg-iconbtn" disabled={currentIdx <= 0} aria-label="Previous section" onClick={goPrev}><RGIcon name="chevronLeft" size={18} /></button>
        <button className="rg-iconbtn" disabled={currentIdx >= assignableSections.length - 1} aria-label="Next section" onClick={goNext}><RGIcon name="chevronRight" size={18} /></button>
        <button className="rg-btn rg-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => setEndingPrompt(true)}>{rescue ? "Done" : "Finish"}</button>
      </div>

      <div className="rg-readscroll" ref={containerRef} onScroll={handleScroll} onMouseUp={onTextMouseUp}>
        {rescue && (
          <div className="rg-rescue-banner" style={{ maxWidth: `${lineWidth}px` }} role="note">
            <RGIcon name="clock" size={15} />
            <span>Ten minutes. The goal is just to stay connected to the book — not to finish anything.</span>
          </div>
        )}
        <div className="rg-reader-body">
          <div className="rg-readcol" ref={colRef} style={{ maxWidth: `${lineWidth}px`, fontSize: `${fontSize}px` }}>
            {paragraphs.map((p) => (
              <p
                key={p.offset}
                data-offset={p.offset}
                ref={(el) => {
                  if (el) paragraphRefs.current.set(p.offset, el);
                  else paragraphRefs.current.delete(p.offset);
                }}
              >
                {renderParagraph(p.text, p.offset, highlights, activeNoteId, setActiveNoteId)}
              </p>
            ))}
          </div>
          <aside className="rg-margin" aria-label="Notes and highlights">
            {sectionNotes.map((n) => (
              <MarginNoteCard
                key={n.id}
                note={n}
                style={{ top: cardTops[n.id] ?? 0 }}
                active={activeNoteId === n.id}
                onActivate={() => setActiveNoteId(n.id)}
                onSaved={refreshNotes}
                onDelete={() => deleteNote(n.id)}
              />
            ))}
          </aside>
        </div>
      </div>

      {sel && (
        <div className="rg-seltoolbar" style={{ left: sel.x, top: sel.y }} role="toolbar" aria-label="Selection actions">
          <button className="rg-seltoolbar-btn" onClick={onHighlight}><RGIcon name="pencil" size={15} /> Highlight</button>
          <button className="rg-seltoolbar-btn" onClick={onMarginNote}><RGIcon name="pencil" size={15} /> Note</button>
          <button className="rg-seltoolbar-btn" onClick={onExplainSelection}><RGIcon name="sparkle" size={15} /> Explain</button>
        </div>
      )}

      {showNote && (
        <NotePanel
          bookId={book.id}
          sessionId={session?.id ?? null}
          chapter={currentSection.label}
          locator={locator}
          onClose={() => setShowNote(false)}
        />
      )}

      {showAi && (
        <AiPanel
          bookId={book.id}
          chapter={currentSection.label}
          locator={locator}
          selection={selection}
          onClose={() => setShowAi(false)}
        />
      )}

      {endingPrompt && (
        <EndingPanel
          rescue={rescue}
          summary={summary}
          setSummary={setSummary}
          onCancel={() => setEndingPrompt(false)}
          onSave={() => finalizeSession()}
        />
      )}
    </section>
  );
}

function splitParagraphs(text: string): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  const re = /\n\s*\n+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = text.slice(last, m.index);
    if (chunk.trim().length > 0) {
      out.push({ offset: last, text: chunk });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const tail = text.slice(last);
    if (tail.trim().length > 0) out.push({ offset: last, text: tail });
  }
  return out;
}

/** Absolute char anchor of a note (for sorting / section scoping). */
function anchorChar(n: Note): number {
  const p = parseLocator(n.anchor_start || n.locator);
  return p.kind === "char" ? parseInt(p.value, 10) : 0;
}

/** Within-section char offset of a DOM point inside the reading column, by
 *  measuring a Range from the enclosing paragraph's start. Robust to the
 *  paragraph being split into <mark> segments. */
function charOffsetWithinSection(node: Node, offset: number, col: HTMLElement): number | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  const p = el?.closest("p[data-offset]") as HTMLElement | null;
  if (!p || !col.contains(p)) return null;
  const base = parseInt(p.dataset.offset || "0", 10);
  const range = document.createRange();
  range.setStart(p, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return base + range.toString().length;
}

/** Render a paragraph's text, wrapping any anchored highlight spans in <mark>.
 *  Offsets are within-section; highlights carry section-local start/end. */
function renderParagraph(
  text: string,
  pOffset: number,
  highlights: Array<{ id: string; start: number; end: number }>,
  activeId: string | null,
  setActive: (id: string) => void,
): ReactNode {
  const pEnd = pOffset + text.length;
  const hits = highlights
    .filter((h) => h.end > pOffset && h.start < pEnd)
    .map((h) => ({ id: h.id, s: Math.max(0, h.start - pOffset), e: Math.min(text.length, h.end - pOffset) }))
    .filter((h) => h.e > h.s)
    .sort((a, b) => a.s - b.s);
  if (hits.length === 0) return text;
  const out: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((h, i) => {
    const start = Math.max(h.s, cursor);
    if (start > cursor) out.push(text.slice(cursor, start));
    if (h.e > start) {
      out.push(
        <mark
          key={`${h.id}-${i}`}
          className={activeId === h.id ? "rg-hl active" : "rg-hl"}
          onClick={(e) => { e.stopPropagation(); setActive(h.id); }}
        >
          {text.slice(start, h.e)}
        </mark>,
      );
      cursor = h.e;
    }
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/** One anchored card in the Companion Margin. User notes are editable with
 *  debounced autosave; saved-AI cards are visually distinct and read-only. */
let saveProgressTimer: number | null = null;
let lastSaveAt = 0;
function throttledSaveProgress(bookId: string, sectionId: string, locator: string, percent: number) {
  const now = Date.now();
  if (saveProgressTimer != null) window.clearTimeout(saveProgressTimer);
  const fire = () => {
    lastSaveAt = Date.now();
    saveProgressTimer = null;
    invoke("cmd_save_section_progress", { bookId, sectionId, locator, percent }).catch(() => {});
  };
  if (now - lastSaveAt > 800) fire();
  else saveProgressTimer = window.setTimeout(fire, 800);
}

function NotePanel(props: {
  bookId: string;
  sessionId: string | null;
  chapter: string;
  locator: string;
  onClose: () => void;
}) {
  const [noteType, setNoteType] = useState<string>("Reflection");
  const [body, setBody] = useState("");
  const [shortQuote, setShortQuote] = useState("");
  const [warn, setWarn] = useState(false);
  const [saving, setSaving] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, props.onClose);

  useEffect(() => {
    let cancelled = false;
    if (!shortQuote) { setWarn(false); return; }
    invoke<boolean>("cmd_quote_warns", { quote: shortQuote }).then((w) => {
      if (!cancelled) setWarn(w);
    });
    return () => { cancelled = true; };
  }, [shortQuote]);

  async function save() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await invoke<Note>("cmd_save_note", {
        bookId: props.bookId,
        sessionId: props.sessionId,
        noteType,
        locator: props.locator,
        chapterLabel: props.chapter,
        body: body.trim(),
        shortQuote: shortQuote.trim() || null,
      });
      props.onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rg-modal-backdrop">
      <div ref={panelRef} className="rg-modal" role="dialog" aria-modal="true" aria-labelledby="text-note-panel-title">
        <div className="rg-modal-head">
          <span className="t" id="text-note-panel-title"><RGIcon name="pencil" size={16} /> New note</span>
          <button className="rg-iconbtn" onClick={props.onClose} aria-label="Close note panel"><RGIcon name="x" size={16} /></button>
        </div>

        <label>Type
          <select className="rg-select" value={noteType} onChange={(e) => setNoteType(e.target.value)}>
            {NOTE_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>

        <div className="row"><span>Chapter: {props.chapter}</span><span>Locator: {props.locator}</span></div>

        <label>Note
          <textarea
            className="rg-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Paraphrase, reflection, or question…"
            autoFocus
          />
        </label>

        <label>Short quote (optional)
          <textarea
            className="rg-input"
            style={{ minHeight: 64, fontFamily: "var(--rg-serif)", resize: "vertical" }}
            value={shortQuote}
            onChange={(e) => setShortQuote(e.target.value)}
            placeholder="Keep it under ~300 characters"
          />
        </label>
        {warn && (
          <p className="rg-warn-text">
            Quote exceeds ~300 characters. Fair use has no fixed safe word count — the default
            posture in ReadingGym is short quotes for private study only. (Saving is still allowed.)
          </p>
        )}

        <div className="panel-actions">
          <button className="rg-btn rg-btn-ghost" onClick={props.onClose}>Cancel</button>
          <button className="rg-btn rg-btn-primary" disabled={saving || !body.trim()} onClick={save}>
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EndingPanel(props: {
  rescue?: boolean;
  summary: string;
  setSummary: (s: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, props.onCancel);
  const { rescue } = props;
  return (
    <div className="rg-modal-backdrop">
      <div ref={panelRef} className="rg-modal" role="dialog" aria-modal="true" aria-labelledby="text-ending-panel-title">
        <div className="rg-modal-head">
          <span className="t" id="text-ending-panel-title">
            <RGIcon name="flag" size={16} /> {rescue ? "That counts" : "Finish session"}
          </span>
          <button className="rg-iconbtn" onClick={props.onCancel} aria-label="Close finish-session panel"><RGIcon name="x" size={16} /></button>
        </div>
        <p className="prompt">
          {rescue
            ? "You stayed connected to the book today. Want to jot one line before you go? (Totally optional.)"
            : "What is one sentence you want to remember from today?"}
        </p>
        <textarea
          className="rg-textarea"
          style={{ minHeight: 90 }}
          value={props.summary}
          onChange={(e) => props.setSummary(e.target.value)}
          autoFocus
          placeholder={rescue ? "Optional — leave blank and just end." : undefined}
        />
        <div className="panel-actions">
          <button className="rg-btn rg-btn-ghost" onClick={props.onCancel}>Keep reading</button>
          <button className="rg-btn rg-btn-primary" onClick={props.onSave}>{rescue ? "That counts — done" : "End session"}</button>
        </div>
      </div>
    </div>
  );
}

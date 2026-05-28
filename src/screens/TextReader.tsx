import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import AiPanel from "./AiPanel";
import { useDialog } from "../hooks/useDialog";
import type { BookSection, Note, ReadingSession, TodayCard } from "../types";
import { NOTE_TYPES, makeCharLocator, parseLocator } from "../types";

interface Props {
  today: TodayCard;
  onExit: () => void;
}

/**
 * Text reader. One session can span many sections via Next › / ‹ Prev.
 * Section completion is derived from "did the reader advance past this section
 * during this sitting?" — no manual mark-complete gate.
 */
export default function TextReader({ today, onExit }: Props) {
  const { book, section: assignedSection } = today;
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

  if (!currentSection) {
    return (
      <section className="screen">
        <div className="card"><p>No section to read.</p><button onClick={onExit}>Back</button></div>
      </section>
    );
  }

  return (
    <section className="reader">
      <div className="reader-toolbar">
        <button className="ghost" onClick={onExit}>← Today</button>
        <div className="reader-title muted">
          {book.title} — {currentSection.label}
          {targetSection && targetSection.id !== currentSection.id && (
            <span className="muted small"> (today's target: {targetSection.label})</span>
          )}
        </div>
        <div className="spacer" />
        <button className="ghost" onClick={() => setFontSize((f) => Math.max(12, f - 1))}>A−</button>
        <button className="ghost" onClick={() => setFontSize((f) => Math.min(28, f + 1))}>A+</button>
        <button className="ghost" onClick={() => setLineWidth((w) => Math.max(420, w - 40))}>↤</button>
        <button className="ghost" onClick={() => setLineWidth((w) => Math.min(900, w + 40))}>↦</button>
        <button className="ghost" onClick={() => setShowNote(true)}>+ Note</button>
        <button
          className="ghost ai-button"
          title="Tutor (prompt preview only — no remote call)"
          onClick={() => {
            const sel = window.getSelection?.()?.toString?.() ?? "";
            if (sel.trim().length >= 4) setSelection(sel);
            setShowAi(true);
          }}
        >
          ✻ Tutor
        </button>
        <button className="ghost" disabled={currentIdx <= 0} onClick={goPrev}>‹ Prev</button>
        <button className="ghost" disabled={currentIdx >= assignableSections.length - 1} onClick={goNext}>Next ›</button>
        <button className="primary" onClick={() => setEndingPrompt(true)}>Finish session</button>
      </div>

      <div className="reader-body" ref={containerRef} onScroll={handleScroll}>
        <div className="reader-column" style={{ maxWidth: `${lineWidth}px` }}>
          {paragraphs.map((p) => (
            <p
              key={p.offset}
              data-offset={p.offset}
              ref={(el) => {
                if (el) paragraphRefs.current.set(p.offset, el);
                else paragraphRefs.current.delete(p.offset);
              }}
              style={{
                fontSize: `${fontSize}px`,
                lineHeight: 1.55,
                fontFamily: '"Iowan Old Style", "Georgia", "Charter", serif',
                margin: "0 0 1em 0",
                whiteSpace: "pre-wrap",
              }}
            >
              {p.text}
            </p>
          ))}
        </div>
      </div>

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
    <div className="panel-backdrop">
      <div
        ref={panelRef}
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-note-panel-title"
      >
        <div className="panel-header">
          <h2 id="text-note-panel-title">New note</h2>
          <button className="ghost" onClick={props.onClose} aria-label="Close note panel">✕</button>
        </div>

        <label>Type
          <select value={noteType} onChange={(e) => setNoteType(e.target.value)}>
            {NOTE_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>

        <div className="row">
          <div className="muted small">Chapter: {props.chapter}</div>
          <div className="muted small">Locator: {props.locator}</div>
        </div>

        <label>Note
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="Paraphrase, reflection, or question…"
            autoFocus
          />
        </label>

        <label>Short quote (optional)
          <textarea
            value={shortQuote}
            onChange={(e) => setShortQuote(e.target.value)}
            rows={3}
            placeholder="Keep it under ~300 characters"
          />
        </label>
        {warn && (
          <p className="warn">
            Quote exceeds ~300 characters. Fair use has no fixed safe word count — the default
            posture in ReadingGym is short quotes for private study only. (Saving is still allowed.)
          </p>
        )}

        <div className="panel-actions">
          <button className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="primary" disabled={saving || !body.trim()} onClick={save}>
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EndingPanel(props: {
  summary: string;
  setSummary: (s: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, props.onCancel);
  return (
    <div className="panel-backdrop">
      <div
        ref={panelRef}
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-ending-panel-title"
      >
        <div className="panel-header">
          <h2 id="text-ending-panel-title">Finish session</h2>
          <button className="ghost" onClick={props.onCancel} aria-label="Close finish-session panel">✕</button>
        </div>
        <p>What is one sentence you want to remember from today?</p>
        <textarea
          value={props.summary}
          onChange={(e) => props.setSummary(e.target.value)}
          rows={3}
          autoFocus
        />
        <div className="panel-actions">
          <button className="ghost" onClick={props.onCancel}>Keep reading</button>
          <button className="primary" onClick={props.onSave}>End session</button>
        </div>
      </div>
    </div>
  );
}

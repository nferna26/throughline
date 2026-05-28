import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ePub from "epubjs";
import AiPanel from "./AiPanel";
import { useDialog } from "../hooks/useDialog";
import type { BookSection, Note, ReadingSession, TodayCard } from "../types";
import { NOTE_TYPES, makeCfiLocator, parseLocator } from "../types";

interface Props {
  today: TodayCard;
  onExit: () => void;
}

/**
 * EPUB reader.
 *
 * CANONICAL READING SEQUENCE: only sections marked assignable. Front/back
 * matter is filtered out by the backend (`cmd_assignable_sections`) and is
 * NEVER reachable through reader navigation. Next/Prev advance through THIS
 * list (calling `rendition.display(href)` so the view actually changes),
 * NOT through epub.js's default whole-spine traversal.
 */
export default function EpubReader({ today, onExit }: Props) {
  const { book, section: assignedSection } = today;
  const [assignableSections, setAssignableSections] = useState<BookSection[]>([]);
  const [currentIdx, setCurrentIdx] = useState<number>(-1);
  const [session, setSession] = useState<ReadingSession | null>(null);
  const [fontSize, setFontSize] = useState<number>(
    () => parseInt(localStorage.getItem("rg.fontSize") || "18", 10)
  );
  const [lineWidth, setLineWidth] = useState<number>(
    () => parseInt(localStorage.getItem("rg.lineWidth") || "640", 10)
  );
  const [showNote, setShowNote] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [selection, setSelection] = useState<string>("");
  const [endingPrompt, setEndingPrompt] = useState(false);
  const [summary, setSummary] = useState("");
  const [cfi, setCfi] = useState<string>("");
  const [percent, setPercent] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("rg.theme") as "light" | "dark") || "light"
  );
  const visitedRef = useRef<Set<string>>(new Set());
  const startedAt = useRef<number>(Date.now());

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  // Live mirror of the canonical list so the rendition's "relocated" handler
  // (a closure captured at setup time) can match against the most current list
  // without us reattaching the listener on every render.
  const assignableRef = useRef<BookSection[]>([]);

  useEffect(() => { localStorage.setItem("rg.fontSize", String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem("rg.lineWidth", String(lineWidth)); }, [lineWidth]);

  useEffect(() => {
    let cancelled = false;
    let rendition: any = null;
    let epubBook: any = null;

    async function load() {
      if (!assignedSection || !viewerRef.current) return;
      try {
        const list = await invoke<BookSection[]>("cmd_assignable_sections", { bookId: book.id });
        if (cancelled) return;
        if (list.length === 0) {
          throw new Error("no assignable sections in this book");
        }
        setAssignableSections(list);
        assignableRef.current = list;

        // Initial index = where the plan put us, falling back to the first
        // assignable item. NEVER an arbitrary spine entry.
        const fromAssigned = list.findIndex((s) => s.id === assignedSection.id);
        const startIdx = fromAssigned >= 0 ? fromAssigned : 0;
        setCurrentIdx(startIdx);
        visitedRef.current = new Set([list[startIdx].id]);

        const bytes = await invoke<number[] | Uint8Array>("cmd_read_book_bytes", { bookId: book.id });
        if (cancelled) return;
        const buffer = bytes instanceof Uint8Array ? bytes.buffer : new Uint8Array(bytes).buffer;
        epubBook = ePub(buffer as ArrayBuffer);
        bookRef.current = epubBook;
        // manager: "default" + flow: "scrolled-doc"
        //   one document at a time, vertical scroll within it.
        //   rendition.display(href) swaps the rendered document.
        //   This is what makes Next/Prev actually change what's visible.
        // Avoid "continuous": it renders the whole spine into one canvas and
        //   starts at spine[0] (= the cover) regardless of display() target.
        rendition = epubBook.renderTo(viewerRef.current, {
          width: "100%",
          height: "100%",
          flow: "scrolled-doc",
          manager: "default",
          spread: "none",
        });
        renditionRef.current = rendition;
        applyTheme(rendition, theme, fontSize, lineWidth);

        // Where to display first: resume CFI if any, else the assigned-section href.
        let target: string | undefined;
        if (today.resume_locator) {
          const parsed = parseLocator(today.resume_locator);
          if (parsed.kind === "cfi") target = parsed.value;
        }
        if (!target) target = list[startIdx].href || undefined;
        if (!target) throw new Error("assigned section has no href");
        await rendition.display(target);

        await epubBook.locations.generate(1024).catch(() => undefined);

        // Selection capture — three layers, since epub.js's "selected" event
        // is inconsistent across versions and content layouts:
        //   1. The "selected" event (when it fires).
        //   2. Direct mouseup/keyup listeners on every rendered iframe.
        //   3. A live read at the moment ✻ Tutor is clicked (see goAskTutor).
        const captureFromContents = (contents: any) => {
          try {
            const text: string = contents?.window?.getSelection?.()?.toString?.() ?? "";
            if (text && text.trim().length >= 4) setSelection(text);
          } catch { /* ignore */ }
        };
        rendition.on("selected", (_cfiRange: string, contents: any) => {
          captureFromContents(contents);
        });
        rendition.on("rendered", (_section: any, contents: any) => {
          const doc = contents?.document;
          if (!doc) return;
          const onSelect = () => captureFromContents(contents);
          doc.addEventListener("mouseup", onSelect);
          doc.addEventListener("keyup", onSelect);
          doc.addEventListener("touchend", onSelect);
          // Also listen to selectionchange — fires while dragging but is the most reliable
          // signal that text is actually selected in this iframe.
          doc.addEventListener("selectionchange", onSelect);
        });

        rendition.on("relocated", (loc: any) => {
          const newCfi: string = loc?.start?.cfi || "";
          const href: string | undefined = loc?.start?.href;
          const newPct: number =
            typeof loc?.start?.percentage === "number"
              ? Math.round(loc.start.percentage * 1000) / 10
              : 0;
          if (newCfi) setCfi(newCfi);
          setPercent(newPct);

          if (href) {
            // Match to the CANONICAL list, not the full spine. If the user lands
            // on a non-assignable doc (shouldn't happen via our Next/Prev, but
            // could via in-document links), we simply don't update currentIdx;
            // the toolbar still reflects the last assignable section.
            const matched = matchSectionByHref(assignableRef.current, href);
            if (matched) {
              const idx = assignableRef.current.findIndex((s) => s.id === matched.id);
              if (idx >= 0) {
                setCurrentIdx(idx);
                if (!visitedRef.current.has(matched.id)) {
                  visitedRef.current.add(matched.id);
                }
              }
              if (newCfi) {
                throttledSaveProgress(book.id, matched.id, makeCfiLocator(newCfi), newPct);
              }
            }
          }
        });

        const s = await invoke<ReadingSession>("cmd_start_session", {
          bookId: book.id,
          sectionId: list[startIdx].id,
          startLocator: today.resume_locator
            ? today.resume_locator
            : (target ? makeCfiLocator(target) : null),
        });
        if (cancelled) return;
        setSession(s);
        startedAt.current = Date.now();
      } catch (e: any) {
        console.error(e);
        setError(`EPUB rendering unavailable for this book: ${e?.message || e}`);
      }
    }
    load();
    return () => {
      cancelled = true;
      try { rendition?.destroy(); } catch {}
      try { epubBook?.destroy(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, assignedSection?.id]);

  useEffect(() => {
    if (renditionRef.current) {
      applyTheme(renditionRef.current, theme, fontSize, lineWidth);
    }
    localStorage.setItem("rg.theme", theme);
  }, [theme, fontSize, lineWidth]);

  // Keep the live mirror in sync whenever the canonical list changes.
  useEffect(() => { assignableRef.current = assignableSections; }, [assignableSections]);

  // Next / Prev navigate the CANONICAL list and call `rendition.display(href)`
  // for real, so the rendered page actually changes (the bug Shot 2 had was
  // calling `rendition.next()` which advances within the full spine).
  function goNext() {
    const next = currentIdx + 1;
    if (next < 0 || next >= assignableSections.length) return;
    const target = assignableSections[next];
    setCurrentIdx(next);
    visitedRef.current.add(target.id);
    if (renditionRef.current && target.href) {
      renditionRef.current.display(target.href).catch((err: any) => {
        console.error("rendition.display failed", err);
      });
    }
  }
  function goPrev() {
    const prev = currentIdx - 1;
    if (prev < 0 || prev >= assignableSections.length) return;
    const target = assignableSections[prev];
    setCurrentIdx(prev);
    visitedRef.current.add(target.id);
    if (renditionRef.current && target.href) {
      renditionRef.current.display(target.href).catch((err: any) => {
        console.error("rendition.display failed", err);
      });
    }
  }

  async function finalizeSession() {
    // Always end the session, even from the error / no-rendition state.
    const minutes = session
      ? Math.max(1, Math.round((Date.now() - startedAt.current) / 60000))
      : 1;
    const endLoc = cfi ? makeCfiLocator(cfi) : null;

    // Mark every visited section EXCEPT the current one as complete (the user
    // crossed those). Include the current one too if percent >= 95.
    const visited = Array.from(visitedRef.current);
    const completedIds: string[] = [];
    for (const v of visited) {
      const idx = assignableRef.current.findIndex((s) => s.id === v);
      if (idx >= 0 && idx < currentIdx) completedIds.push(v);
    }
    if (currentIdx >= 0 && percent >= 95) {
      const id = assignableRef.current[currentIdx]?.id;
      if (id) completedIds.push(id);
    }

    if (session) {
      try {
        await invoke<ReadingSession>("cmd_end_session", {
          sessionId: session.id,
          endLocator: endLoc,
          minutes,
          completedSectionIds: completedIds,
          summarySentence: summary.trim() || null,
        });
      } catch (e) {
        console.error("cmd_end_session failed", e);
      }
    }
    onExit();
  }

  const currentSection = assignableSections[currentIdx];
  const assignedInCanonical = assignedSection
    ? assignableSections.find((s) => s.id === assignedSection.id)
    : undefined;

  return (
    <section className="reader">
      <div className="reader-toolbar">
        <button className="ghost" onClick={onExit}>← Today</button>
        <div className="reader-title muted">
          {book.title} — {currentSection?.label ?? "…"}
          {assignedInCanonical && currentSection && assignedInCanonical.id !== currentSection.id && (
            <span className="muted small"> (today's target: {assignedInCanonical.label})</span>
          )}
        </div>
        <div className="spacer" />
        <span className="muted small">{percent}%</span>
        <button className="ghost" onClick={() => setFontSize((f) => Math.max(12, f - 1))}>A−</button>
        <button className="ghost" onClick={() => setFontSize((f) => Math.min(28, f + 1))}>A+</button>
        <button className="ghost" onClick={() => setLineWidth((w) => Math.max(420, w - 40))}>↤</button>
        <button className="ghost" onClick={() => setLineWidth((w) => Math.min(900, w + 40))}>↦</button>
        <button className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☼" : "☾"}</button>
        <button className="ghost" onClick={() => setShowNote(true)}>+ Note</button>
        <button
          className="ghost ai-button"
          title="Tutor (selection-only context)"
          onClick={() => {
            // Live read: walk every Contents object the rendition currently has
            // loaded, ask each iframe's window for its active selection. This
            // catches the case where the "selected" event didn't fire but the
            // user is clearly looking at highlighted text.
            try {
              const contentsList = renditionRef.current?.getContents?.() ?? [];
              for (const c of contentsList) {
                const t = c?.window?.getSelection?.()?.toString?.() ?? "";
                if (t && t.trim().length >= 4) {
                  setSelection(t);
                  break;
                }
              }
            } catch { /* ignore */ }
            setShowAi(true);
          }}
        >
          ✻ Tutor
        </button>
        <button className="ghost" disabled={currentIdx <= 0} onClick={goPrev}>‹ Prev</button>
        <button className="ghost" disabled={currentIdx >= assignableSections.length - 1} onClick={goNext}>Next ›</button>
        <button className="primary" onClick={() => setEndingPrompt(true)}>Finish session</button>
      </div>

      {error ? (
        <div className="reader-body">
          <div className="card" style={{ margin: "40px auto" }}>
            <h2>EPUB rendering unavailable</h2>
            <p className="muted">{error}</p>
            <p className="hint">The source file is preserved at <code>{book.source_path}</code>.</p>
            <button onClick={onExit}>Back</button>
          </div>
        </div>
      ) : (
        <div className="reader-body epub-host" data-theme={theme}>
          <div ref={viewerRef} className="epub-viewer" />
        </div>
      )}

      {showNote && (
        <NotePanel
          bookId={book.id}
          sessionId={session?.id ?? null}
          chapter={currentSection?.label ?? assignedSection?.label ?? ""}
          locator={cfi ? makeCfiLocator(cfi) : `percent:${percent}`}
          onClose={() => setShowNote(false)}
        />
      )}

      {showAi && (
        <AiPanel
          bookId={book.id}
          chapter={currentSection?.label ?? assignedSection?.label ?? null}
          locator={cfi ? makeCfiLocator(cfi) : `percent:${percent}`}
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

function matchSectionByHref(sections: BookSection[], href: string): BookSection | undefined {
  if (!sections.length) return undefined;
  const norm = (s: string) => s.replace(/^.*\//, "").replace(/#.*$/, "").toLowerCase();
  const target = norm(href);
  let m = sections.find((s) => s.href && norm(s.href) === target);
  if (m) return m;
  m = sections.find((s) => s.href && (s.href.endsWith(href) || href.endsWith(s.href)));
  return m;
}

function applyTheme(rendition: any, theme: "light" | "dark", fontSize: number, lineWidth: number) {
  const bg = theme === "dark" ? "#14161a" : "#f7f5ef";
  const ink = theme === "dark" ? "#e8e6e1" : "#1c1b18";
  const link = theme === "dark" ? "#a7c5b1" : "#2f4e3a";
  rendition.themes.register("rg", {
    "html, body": {
      "background": `${bg} !important`,
      "color": `${ink} !important`,
    },
    "body": {
      "font-family": '"Iowan Old Style", "Georgia", "Charter", serif !important',
      "font-size": `${fontSize}px !important`,
      "line-height": "1.55 !important",
      "max-width": `${lineWidth}px !important`,
      "margin": "0 auto !important",
      "padding": "24px !important",
    },
    // Force page-container backgrounds to inherit so author CSS like
    // `div.page { background: #d8dae0 }` doesn't paint a slab behind the text.
    // We deliberately do NOT include `pre`, `code`, `table`, `th`, `td`, or
    // `blockquote` — those often use a subtle background by design and stripping
    // them would hurt legibility.
    "div, main, article, section, header, footer, nav, aside": {
      "background": "transparent !important",
      "background-color": "transparent !important",
    },
    "p, li, blockquote": { "color": `${ink} !important` },
    "h1, h2, h3, h4, h5, h6": {
      "color": `${ink} !important`,
      "font-family": '"Iowan Old Style", "Georgia", serif !important',
    },
    "a, a:link, a:visited": { "color": `${link} !important`, "text-decoration": "none !important" },
    "img": { "max-width": "100% !important", "height": "auto !important" },
  });
  rendition.themes.select("rg");
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
        aria-labelledby="epub-note-panel-title"
      >
        <div className="panel-header">
          <h2 id="epub-note-panel-title">New note</h2>
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
        aria-labelledby="epub-ending-panel-title"
      >
        <div className="panel-header">
          <h2 id="epub-ending-panel-title">Finish session</h2>
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

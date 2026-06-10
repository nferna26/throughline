import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import MarginNoteCard from "../components/MarginNoteCard";
import MarginTutorCard, { type TutorDraft, type TutorMode } from "../components/MarginTutorCard";
import SectionBriefingCard from "../components/SectionBriefingCard";
import { briefingTextReady, type MarginHelp } from "../sectionBriefing";
import { segmentParagraph, blockRoleFor, type StyleRange } from "../paragraphStructure";
import { useDialog } from "../hooks/useDialog";
import type { BookSection, Note, ReadingSession, TodayCard, ReaderMode, SettingsDto } from "../types";
import { NOTE_TYPES, errorMessage, makeCharLocator, parseLocator } from "../types";
import { locatorHint } from "../locatorHint";
import { endReached } from "../sectionCompletion";
import { reduceMargin, initialMarginState, marginVisible } from "../marginPanel";

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
  // Identity guard: which section `text` actually belongs to. Cleared the moment
  // currentIdx changes and only set once the matching section's text resolves, so
  // Deep Study can never generate/cache a briefing from the previous section's
  // text while we're mid-navigation. null = text not yet loaded for the current
  // section.
  const [textSectionId, setTextSectionId] = useState<string | null>(null);
  // Style ranges for the current section (headings/blockquotes/emphasis), in
  // section-relative UTF-16 offsets. Empty for plain .txt books; populated for
  // EPUB-derived text so the reader can style it without mutating offsets.
  const [structure, setStructure] = useState<StyleRange[]>([]);
  // Paragraphs derive from text + structure: code-block ("pre") ranges are emitted
  // as non-reflowed monospace paragraphs; everything else reflows as prose. Recomputes
  // when the (async) structure arrives, so code stops being double-spaced.
  const paragraphs = useMemo(
    () => splitParagraphs(text, structure.filter((r) => r.kind === "pre")),
    [text, structure],
  );
  const [session, setSession] = useState<ReadingSession | null>(null);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  // Sections whose END the reader's viewport actually reached this sitting
  // (endReached, ../sectionCompletion): updated on scroll, and measured once
  // after a section's text paints so a section that fits one screen — which
  // never fires a scroll event — can still be finished by reading it.
  const [reachedEnd, setReachedEnd] = useState<Set<string>>(new Set());
  const [fontSize, setFontSize] = useState<number>(
    () => parseInt(localStorage.getItem("tl.fontSize") || "18", 10)
  );
  const [lineWidth, setLineWidth] = useState<number>(
    () => parseInt(localStorage.getItem("tl.lineWidth") || "640", 10)
  );
  const [showNote, setShowNote] = useState(false);
  const [topOffset, setTopOffset] = useState<number>(0);
  const startedAt = useRef<number>(Date.now());
  const [endingPrompt, setEndingPrompt] = useState(false);
  const [summary, setSummary] = useState("");
  // ── Companion Margin: anchored notes/highlights/tutor cards beside the text ──
  const [notes, setNotes] = useState<Note[]>([]);
  // Draft tutor cards live only in component state until the reader saves one
  // (which turns it into a durable TutorNote via the existing approval path).
  const [tutorDrafts, setTutorDrafts] = useState<TutorDraft[]>([]);
  const [sel, setSel] = useState<{ x: number; y: number; below: boolean; start: number; end: number; text: string } | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  // Companion side panel: collapsible + drag-resizable, both persisted. Cards
  // render in document order inside it (no absolute positioning), so a spawned
  // tutor draft is always visible and the reading column owns the rest of the
  // window — text stays centered/responsive instead of pinned left.
  //
  // DEFAULT CLOSED: the reader opens to a clean, full-width centered column
  // (balanced at any window size). The panel auto-opens the instant the reader
  // captures something (highlight / note / tutor), and the toolbar toggle shows
  // a count badge when the section has notes. The open/closed choice persists.
  // Companion-margin visibility is a tiny reducer (see ../marginPanel): the reader
  // opens to a single clean column and the margin is brought in only when it holds
  // something. `pinned` (the toolbar toggle) persists; a bare selection never opens it.
  const [marginState, dispatchMargin] = useReducer(
    reduceMargin,
    localStorage.getItem("tl.panelOpen") === "true",
    initialMarginState,
  );
  const panelOpen = marginState.open;
  const pinned = marginState.pinned;
  const [panelWidth, setPanelWidth] = useState<number>(
    () => clampPanelWidth(parseInt(localStorage.getItem("tl.panelWidth") || "320", 10))
  );
  const draggingRef = useRef<boolean>(false);
  const readerRef = useRef<HTMLElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);

  // Margin-help mode (quiet | guided | deep_study) drives how present the margin
  // is. Loaded from settings once; defaults to "guided" until it resolves.
  const [marginHelp, setMarginHelp] = useState<MarginHelp>("guided");
  // Section ids whose Deep Study briefing the reader has dismissed this sitting,
  // so dismiss sticks without re-spawning the card on every render.
  const [briefingDismissed, setBriefingDismissed] = useState<Set<string>>(new Set());
  // Ensure Deep Study opens the panel once per opened section (never fighting a
  // manual toggle: only fires when the section the briefing is for changes).
  const deepOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings")
      .then((s) => {
        const m = s.margin_help === "quiet" || s.margin_help === "deep_study" ? s.margin_help : "guided";
        setMarginHelp(m as MarginHelp);
      })
      .catch(() => {});
  }, []);

  const refreshNotes = useCallback(async () => {
    try {
      const all = await invoke<Note[]>("cmd_list_notes", { bookId: book.id });
      setNotes(all);
    } catch { /* notes are non-critical to reading */ }
  }, [book.id]);
  useEffect(() => { refreshNotes(); }, [refreshNotes]);

  useEffect(() => { localStorage.setItem("tl.fontSize", String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem("tl.lineWidth", String(lineWidth)); }, [lineWidth]);
  // Persist the reader's open-preference (the pin) under the long-standing key.
  useEffect(() => { localStorage.setItem("tl.panelOpen", String(pinned)); }, [pinned]);
  useEffect(() => { localStorage.setItem("tl.panelWidth", String(panelWidth)); }, [panelWidth]);

  // Drag the resizer: panel width = window-right-edge minus pointer x, clamped.
  const startPanelDrag = useCallback((e: React.MouseEvent, opts?: { opening?: boolean }) => {
    e.preventDefault();
    draggingRef.current = true;
    // Grabbing the collapsed edge first re-opens the margin; this same drag then
    // sizes it (so it never re-collapses out from under the opening gesture).
    const opening = !!opts?.opening;
    if (opening) dispatchMargin("show");
    const cleanup = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !readerRef.current) return;
      const right = readerRef.current.getBoundingClientRect().right;
      const outcome = panelDragOutcome(right - ev.clientX);
      // Slide the divider past the minimum → collapse to the clean column, and
      // reset the width so the Margin toggle reopens at a comfortable default
      // (never while opening from the edge — that drag only sizes the panel up).
      if (outcome.kind === "collapse" && !opening) {
        setPanelWidth(DEFAULT_PANEL_WIDTH);
        dispatchMargin("hide");
        cleanup();
        return;
      }
      setPanelWidth(outcome.kind === "resize" ? outcome.width : MIN_PANEL_WIDTH);
    };
    const onUp = () => cleanup();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

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
    // Stale-text guard: clear the text↔section identity immediately so nothing
    // (esp. Deep Study generation) treats the previous section's text as this
    // section's until the awaited load resolves for THIS section.
    const sec = assignableSections[currentIdx];
    setTextSectionId(null);
    setStructure([]);
    async function loadSection() {
      if (!sec) return;
      const t = await invoke<string>("cmd_read_section_text", {
        bookId: book.id,
        sectionId: sec.id,
      });
      if (cancelled) return;
      setText(t);
      setTextSectionId(sec.id);
      // Structure ranges are a separate, optional read (EPUB-derived text only).
      // Failure or absence simply means unstyled paragraphs — never blocks reading.
      invoke<StyleRange[]>("cmd_read_section_structure", { bookId: book.id, sectionId: sec.id })
        .then((ranges) => { if (!cancelled) setStructure(Array.isArray(ranges) ? ranges : []); })
        .catch(() => { if (!cancelled) setStructure([]); });
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

  const markEndReached = useCallback((sectionId: string) => {
    setReachedEnd((prev) => {
      if (prev.has(sectionId)) return prev;
      const next = new Set(prev);
      next.add(sectionId);
      return next;
    });
  }, []);

  // One measurement after the current section's text paints: a section shorter
  // than the viewport never scrolls, so this is its only chance to count as
  // read to the end. Gated on textSectionId so it never measures stale text,
  // and on a laid-out viewport (clientHeight > 0) so a hidden container can
  // never complete a section by accident.
  useEffect(() => {
    const el = containerRef.current;
    const sec = assignableSections[currentIdx];
    if (!el || !sec || textSectionId !== sec.id) return;
    if (el.clientHeight > 0 && endReached(el)) markEndReached(sec.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textSectionId, currentIdx, assignableSections, markEndReached]);

  // Focus the reading column once the current section's text mounts, so Space and
  // the arrows page immediately after the reader opens — never stealing focus from
  // an open note/modal field the reader is typing in (only claims it from the body).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || textSectionId == null) return;
    const active = document.activeElement;
    if (active && active !== document.body && el !== active && !el.contains(active)) return;
    el.focus({ preventScroll: true });
  }, [textSectionId]);

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
    const container = containerRef.current;
    const scrollTop = container.scrollTop;
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
      // The viewport's bottom reaching the end of the text is what finishes
      // the section — sticky for the rest of the sitting once it happens.
      // Guard against the section-switch window (same as the paint effect):
      // a scroll event measured against the OLD text's geometry must not mark
      // the newly current section.
      if (textSectionId === sec.id && endReached(container)) markEndReached(sec.id);
      const baseOffset = parseInt(sec.start_locator || "0", 10);
      const total = (sec.estimated_units || text.length) || 1;
      const pct = Math.min(100, Math.max(0, (off / total) * 100));
      const locator = makeCharLocator(baseOffset + off);
      throttledSaveProgress(book.id, sec.id, locator, pct);
    }
  }

  // Keyboard paging: Space is the most ingrained reading gesture on a Mac, and a
  // book that can't be turned by keyboard is a WCAG 2.1.1 gap. Handles Space /
  // Shift+Space, PageUp/PageDown, arrows, and Home/End as scroll deltas on the
  // reading column, then reconciles progress via handleScroll. Lets editable
  // targets (note textareas) keep their native Space/arrows.
  function onReaderKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = containerRef.current;
    if (!el) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const page = Math.max(40, el.clientHeight * 0.9);
    const line = 60;
    let delta: number | null = null;
    let absolute: number | null = null;
    switch (e.key) {
      case " ": case "Spacebar": delta = e.shiftKey ? -page : page; break;
      case "PageDown": delta = page; break;
      case "PageUp": delta = -page; break;
      case "ArrowDown": delta = line; break;
      case "ArrowUp": delta = -line; break;
      case "Home": absolute = 0; break;
      case "End": absolute = el.scrollHeight; break;
      default: return;
    }
    e.preventDefault();
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const next = absolute != null ? absolute : el.scrollTop + (delta ?? 0);
    el.scrollTop = Math.min(max, Math.max(0, next));
    handleScroll();
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

  // Sections "completed" this sitting: every visited section we've moved past,
  // plus the current one if the viewport reached its end. Shared by the recap
  // preview and the actual finalize so the numbers the reader sees match what's
  // saved.
  function completedSectionIds(): string[] {
    const sec = assignableSections[currentIdx];
    const completed: string[] = [];
    for (const v of visited) {
      if (v !== sec?.id) completed.push(v);
    }
    if (sec && reachedEnd.has(sec.id)) completed.push(sec.id);
    return completed;
  }

  // `takeaway` is passed explicitly (not read from state) so Skip can end with
  // null without racing a setState. Rescue mode never forces a takeaway and
  // never forces section completion — a short sitting still counts.
  async function finalizeSession(takeaway: string | null) {
    if (!session) return onExit();
    const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000));
    const tk = takeaway && takeaway.trim() ? takeaway.trim() : null;
    // The recap's "one sentence to remember" is a first-class Takeaway: it stays
    // in the session export AND becomes a durable, user-authored Takeaway note,
    // so it surfaces in the chapter notebook and on Today's "Last time". Skipping
    // (blank) saves nothing. The body is the reader's own words — privacy-safe.
    if (tk) {
      try {
        await invoke<Note>("cmd_save_note", {
          bookId: book.id,
          sessionId: session.id,
          noteType: "Takeaway",
          locator,
          chapterLabel: currentSection?.label ?? null,
          body: tk,
          shortQuote: null,
          anchorStart: null,
          anchorEnd: null,
          anchoredText: null,
        });
      } catch { /* recap takeaway is best-effort; never block ending a session */ }
    }
    await invoke<ReadingSession>("cmd_end_session", {
      sessionId: session.id,
      endLocator: locator,
      minutes,
      completedSectionIds: completedSectionIds(),
      summarySentence: tk,
    });
    onExit();
  }

  const targetSection = assignedSection;
  const currentSection = assignableSections[currentIdx];

  // Section char range, used to scope notes and to map absolute book locators
  // back to within-section offsets for highlight rendering.
  const secBase = parseInt(currentSection?.start_locator || "0", 10);
  const secEnd = parseInt(currentSection?.end_locator || String(secBase + text.length), 10);

  // Deep Study: once the session has started and this section's text is loaded,
  // open the panel and render the prepared briefing. Fires at most once per
  // section (keyed by deepOpenedFor) so it never overrides a manual close.
  const briefingVisible =
    marginHelp === "deep_study" &&
    !!session &&
    !!currentSection &&
    // Identity guard (pure `briefingTextReady`, unit-tested): only when the
    // loaded text provably belongs to THIS section — never the previous one,
    // mid-navigation. This is what stops the briefing generating/caching against
    // stale text.
    briefingTextReady(currentSection.id, textSectionId, text) &&
    !briefingDismissed.has(currentSection.id);
  useEffect(() => {
    if (briefingVisible && currentSection && deepOpenedFor.current !== currentSection.id) {
      deepOpenedFor.current = currentSection.id;
      dispatchMargin("capture");
    }
  }, [briefingVisible, currentSection]);

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

  // Draft tutor cards anchored inside the current section (by char range).
  const sectionDrafts = useMemo(() => {
    return tutorDrafts
      .filter((d) => {
        const v = parseInt(parseLocator(d.anchorStart).value, 10);
        return Number.isFinite(v) && v >= secBase && v < secEnd;
      })
      .sort((a, b) => parseInt(parseLocator(a.anchorStart).value, 10) - parseInt(parseLocator(b.anchorStart).value, 10));
  }, [tutorDrafts, secBase, secEnd]);

  // Cards render in document order inside the side panel (notes first by anchor,
  // then any live tutor drafts) — no absolute positioning, so they can never be
  // clipped or land in an invisible rail.

  // Collapse the margin when its last item is removed (a real >0 → 0 transition),
  // re-centering the reading column — unless the reader pinned it open. Guarding on
  // the transition avoids fighting the open-on-capture path (0 → 1) or the empty
  // pinned panel the reader deliberately opened.
  const marginContentCount =
    sectionNotes.length + sectionDrafts.length + (briefingVisible ? 1 : 0);
  // Whether the panel actually shows: opened this session, or pinned WITH content.
  // A pinned-but-empty margin on load stays collapsed — the reader opens to a
  // clean column, never an empty half-panel.
  const marginIsVisible = marginVisible(marginState, marginContentCount > 0);
  const prevMarginContent = useRef(marginContentCount);
  useEffect(() => {
    if (panelOpen && !pinned && prevMarginContent.current > 0 && marginContentCount === 0) {
      dispatchMargin("emptied");
    }
    prevMarginContent.current = marginContentCount;
  }, [marginContentCount, panelOpen, pinned]);

  // Dismiss the floating selection toolbar: clear our state AND the native
  // selection (so it doesn't immediately reappear on the next render).
  const dismissSelection = useCallback(() => {
    setSel(null);
    try { window.getSelection?.()?.removeAllRanges(); } catch { /* ignore */ }
  }, []);

  // Escape dismisses the selection toolbar — the keyboard escape hatch the
  // floating toolbar previously lacked (cite: guard-accessibility-baseline-wcag-aa
  // keyboard rules). Only active while a selection toolbar is showing.
  useEffect(() => {
    if (!sel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); dismissSelection(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sel, dismissSelection]);

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
    // Clamp so the toolbar never spills off the reader's left/right edge (it is
    // centered on x via translateX(-50%)) and flips below the line when there's
    // no room above (selecting the very top line).
    const pos = clampToolbarPosition(
      rect.left - rRect.left + rect.width / 2,
      rect.top - rRect.top,
      rRect.width,
      { selectionHeight: rect.height },
    );
    setSel({
      x: pos.x,
      y: pos.y,
      below: pos.below,
      start: secBase + Math.min(start, end),
      end: secBase + Math.max(start, end),
      text,
    });
    // A bare selection raises only the floating action toolbar (rendered below) —
    // never the margin panel. The margin opens when the reader actually captures
    // something, so selecting a passage never crowds the text with an empty panel.
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

  async function onHighlight() { dispatchMargin("capture"); await createAnchoredNote("Highlight"); }
  async function onMarginNote() {
    dispatchMargin("capture");
    const n = await createAnchoredNote("MarginNote");
    if (n) setActiveNoteId(n.id);
  }
  // Mark a confusing passage as a Question in one tap — same anchored-note path,
  // typed Question. The reader can elaborate (or re-tag) in the margin card.
  async function onQuestion() {
    dispatchMargin("capture");
    const n = await createAnchoredNote("Question");
    if (n) setActiveNoteId(n.id);
  }
  // Tutor help is anchored, opt-in, and scoped to the selected text: spawn a
  // DRAFT margin card (prompt-preview only — nothing is sent). It becomes a
  // durable note only if the reader saves it.
  function spawnTutorDraft(mode: TutorMode) {
    if (!sel || sel.text.trim().length < 1) { setSel(null); return; }
    const draft: TutorDraft = {
      draftId: `draft_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
      mode,
      locator: makeCharLocator(sel.start),
      anchorStart: makeCharLocator(sel.start),
      anchorEnd: makeCharLocator(sel.end),
      anchoredText: sel.text,
      chapter: currentSection?.label ?? "",
    };
    setTutorDrafts((d) => [...d, draft]);
    setActiveNoteId(draft.draftId);
    dispatchMargin("capture"); // make sure the new draft card is visible
    window.getSelection?.()?.removeAllRanges();
    setSel(null);
  }
  // Deep Study v2 marker tap → a Context tutor draft about a briefing theme
  // (not a passage selection). Anchored at the section start; the "anchored text"
  // is the short AI-derived theme, sent only to the local model. Reader-initiated.
  function spawnContextMarker(theme: string) {
    const t = theme.trim();
    if (t.length < 1) return;
    const draft: TutorDraft = {
      draftId: `draft_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
      mode: "historical",
      locator: makeCharLocator(secBase),
      anchorStart: makeCharLocator(secBase),
      anchorEnd: makeCharLocator(secBase),
      anchoredText: t,
      chapter: currentSection?.label ?? "",
    };
    setTutorDrafts((d) => [...d, draft]);
    setActiveNoteId(draft.draftId);
    dispatchMargin("capture");
  }
  async function onTutorSaved(draftId: string, noteId: string) {
    setTutorDrafts((d) => d.filter((x) => x.draftId !== draftId));
    setActiveNoteId(noteId);
    await refreshNotes();
  }
  function onTutorDiscard(draftId: string) {
    setTutorDrafts((d) => d.filter((x) => x.draftId !== draftId));
    if (activeNoteId === draftId) setActiveNoteId(null);
  }
  async function deleteNote(id: string) {
    try { await invoke("cmd_delete_note", { noteId: id }); } catch { /* ignore */ }
    if (activeNoteId === id) setActiveNoteId(null);
    await refreshNotes();
  }

  if (!currentSection) {
    return (
      <div className="tl-reader">
        <div className="tl-readscroll"><div className="tl-readcol"><p>No section to read.</p>
          <button className="tl-btn tl-btn-ghost" onClick={onExit}>Back</button></div></div>
      </div>
    );
  }

  return (
    <section className="tl-reader" ref={readerRef}>
      <div className="tl-readtoolbar">
        <button className="tl-back" onClick={onExit}><TLIcon name="chevronLeft" size={18} /> Today</button>
        <span className="tl-tb-title">
          {currentSection.label}
          {targetSection && targetSection.id !== currentSection.id && ` · today: ${targetSection.label}`}
        </span>
        <div className="spacer" />
        <div className="grp bordered" role="group" aria-label="Font size">
          <button className="tl-iconbtn" aria-label="Smaller text" onClick={() => setFontSize((f) => Math.max(12, f - 1))}><TLIcon name="minus" size={16} /></button>
          <span className="tl-tb-label"><TLIcon name="type" size={16} /></span>
          <button className="tl-iconbtn" aria-label="Larger text" onClick={() => setFontSize((f) => Math.min(28, f + 1))}><TLIcon name="plus" size={16} /></button>
        </div>
        <div className="grp bordered" role="group" aria-label="Line width">
          {[520, 640, 760].map((w, i) => (
            <button
              key={w}
              className={lineWidth === w ? "tl-iconbtn active" : "tl-iconbtn"}
              aria-pressed={lineWidth === w}
              aria-label={`Line width ${["narrow", "medium", "wide"][i]}`}
              style={{ width: 26 }}
              onClick={() => setLineWidth(w)}
            >
              <span style={{ display: "block", height: 2, borderRadius: 2, background: "currentColor", width: [9, 13, 17][i] }} />
            </button>
          ))}
        </div>
        <div className="tl-tb-div" />
        <button className={showNote ? "tl-iconbtn active" : "tl-iconbtn"} aria-label="Add note" title="Add note (or select text for the Companion Margin)" onClick={() => setShowNote(true)}><TLIcon name="pencil" size={18} /></button>
        <div className="tl-tb-div" />
        <button className="tl-iconbtn" disabled={currentIdx <= 0} aria-label="Previous section" onClick={goPrev}><TLIcon name="chevronLeft" size={18} /></button>
        <button className="tl-iconbtn" disabled={currentIdx >= assignableSections.length - 1} aria-label="Next section" onClick={goNext}><TLIcon name="chevronRight" size={18} /></button>
        <div className="tl-tb-div" />
        <button
          className={marginIsVisible ? "tl-iconbtn tl-paneltoggle active" : "tl-iconbtn tl-paneltoggle"}
          aria-label={marginIsVisible ? "Hide notes panel" : "Show notes panel"}
          aria-pressed={marginIsVisible}
          title={marginIsVisible ? "Hide notes panel" : "Show notes panel"}
          onClick={() => dispatchMargin(marginIsVisible ? "hide" : "show")}
        >
          <TLIcon name="columns" size={18} />
          {!marginIsVisible && (sectionNotes.length + sectionDrafts.length) > 0 && (
            <span className="tl-panelcount">{sectionNotes.length + sectionDrafts.length}</span>
          )}
        </button>
        <button className="tl-btn tl-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => setEndingPrompt(true)}>{rescue ? "Done" : "Finish"}</button>
      </div>

      <div className="tl-reader-body">
        <div
          className="tl-reader-main"
          ref={containerRef}
          tabIndex={0}
          onScroll={handleScroll}
          onMouseUp={onTextMouseUp}
          onKeyDown={onReaderKeyDown}
        >
          {rescue && (
            <div className="tl-rescue-banner" style={{ maxWidth: `${lineWidth}px` }} role="note">
              <TLIcon name="clock" size={15} />
              <span>Ten minutes. The goal is just to stay connected to the book — not to finish anything.</span>
            </div>
          )}
          <div className="tl-readcol" ref={colRef} style={{ maxWidth: `${lineWidth}px`, fontSize: `${fontSize}px` }}>
            {paragraphs.map((p) => {
              // Block role (heading/blockquote) styles the WHOLE paragraph via a
              // class — never a heading TAG, so it stays a `p[data-offset]` and
              // selection anchoring keeps working. Inline emphasis is composed
              // inside renderParagraph.
              const role = blockRoleFor(p.offset, p.text.length, structure);
              const cls = p.pre ? "tl-block tl-pre" : role ? `tl-block tl-${role}` : undefined;
              return (
                <p
                  key={p.offset}
                  data-offset={p.offset}
                  className={cls}
                  ref={(el) => {
                    if (el) paragraphRefs.current.set(p.offset, el);
                    else paragraphRefs.current.delete(p.offset);
                  }}
                >
                  {renderParagraph(p.text, p.offset, highlights, structure, activeNoteId, setActiveNoteId)}
                </p>
              );
            })}
          </div>
        </div>

        {/* The margin stays MOUNTED when collapsed (hidden via display:none), so a
            tutor card's in-flight stream finishes and its answer persists — reopening
            shows it instantly with NO re-call to the model. Only visibility toggles. */}
        {marginIsVisible && (
          <div
            className={draggingRef.current ? "tl-panel-resizer dragging" : "tl-panel-resizer"}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize notes panel"
            onMouseDown={startPanelDrag}
          />
        )}
        <aside
          className="tl-sidepanel"
          style={{
            flexBasis: `${panelWidth}px`,
            width: `${panelWidth}px`,
            display: marginIsVisible ? undefined : "none",
          }}
          aria-hidden={!marginIsVisible}
          aria-label="Notes, highlights, and tutor cards"
        >
              <div className="tl-sidepanel-head">
                <span>Margin</span>
                <button className="tl-iconbtn" aria-label="Hide notes panel" title="Hide notes panel" onClick={() => dispatchMargin("hide")}>
                  <TLIcon name="x" size={15} />
                </button>
              </div>
              {/* Deep Study: prepared briefing for today's section, above notes. */}
              {briefingVisible && currentSection && (
                <SectionBriefingCard
                  key={currentSection.id}
                  bookId={book.id}
                  bookTitle={book.title}
                  author={book.author}
                  sectionId={currentSection.id}
                  sourceSha={book.source_sha256}
                  mode="deep_study"
                  chapter={currentSection.label ?? ""}
                  locator={makeCharLocator(secBase)}
                  sectionText={text}
                  onDismiss={() =>
                    setBriefingDismissed((prev) => new Set(prev).add(currentSection.id))
                  }
                  onAskContext={spawnContextMarker}
                />
              )}

              {/* Empty-state hint: only when the margin is actually shown (it has no
                  state to preserve, so it's safe to drop from the DOM when hidden). */}
              {marginIsVisible && sectionNotes.length === 0 && sectionDrafts.length === 0 && !briefingVisible && marginHelp !== "quiet" && (
                <p className="tl-sidepanel-empty">
                  Select a passage to highlight, add a note, or open a tutor prompt. Anything you capture collects here, beside the text.
                </p>
              )}
              {sectionNotes.map((n) => (
                <MarginNoteCard
                  key={n.id}
                  note={n}
                  active={activeNoteId === n.id}
                  onActivate={() => setActiveNoteId(n.id)}
                  onSaved={refreshNotes}
                  onDelete={() => deleteNote(n.id)}
                />
              ))}
              {sectionDrafts.map((d) => (
                <MarginTutorCard
                  key={d.draftId}
                  bookId={book.id}
                  bookTitle={book.title}
                  author={book.author}
                  draft={d}
                  active={activeNoteId === d.draftId}
                  onActivate={() => setActiveNoteId(d.draftId)}
                  onSaved={(note) => onTutorSaved(d.draftId, note.id)}
                  onDiscard={() => onTutorDiscard(d.draftId)}
                />
              ))}
        </aside>
        {/* Collapsed: a slim edge grab to slide the margin back open. */}
        {!marginIsVisible && (
          <div
            className="tl-margin-reopen"
            role="separator"
            aria-orientation="vertical"
            aria-label="Open the margin"
            title="Drag to open the margin"
            onMouseDown={(e) => startPanelDrag(e, { opening: true })}
          />
        )}
      </div>

      {sel && (
        <div className={sel.below ? "tl-seltoolbar below" : "tl-seltoolbar"} style={{ left: sel.x, top: sel.y }} role="toolbar" aria-label="Selection actions — press Escape to dismiss" aria-keyshortcuts="Escape">
          <button className="tl-seltoolbar-btn" onClick={onHighlight}><TLIcon name="pencil" size={15} /> Highlight</button>
          <button className="tl-seltoolbar-btn" onClick={onMarginNote}><TLIcon name="pencil" size={15} /> Note</button>
          <button className="tl-seltoolbar-btn" onClick={onQuestion}><TLIcon name="help" size={15} /> Question</button>
          <span className="tl-seltoolbar-div" />
          <button className="tl-seltoolbar-btn" onClick={() => spawnTutorDraft("explain")}><TLIcon name="sparkle" size={15} /> Explain</button>
          <button className="tl-seltoolbar-btn" onClick={() => spawnTutorDraft("historical")}>Context</button>
          <button className="tl-seltoolbar-btn" onClick={() => spawnTutorDraft("vocabulary")}>Define</button>
        </div>
      )}

      {showNote && (
        <NotePanel
          bookId={book.id}
          sessionId={session?.id ?? null}
          chapter={currentSection.label}
          locator={locator}
          positionHint={locatorHint(locator, { start: secBase, length: Math.max(0, secEnd - secBase) })}
          onClose={() => setShowNote(false)}
        />
      )}

      {endingPrompt && (() => {
        const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000));
        const ids = completedSectionIds();
        const labels = assignableSections.filter((s) => ids.includes(s.id)).map((s) => s.label);
        // Count what was captured THIS sitting (created at/after session start).
        const startMs = startedAt.current - 2000; // small skew tolerance
        const mine = notes.filter((n) => {
          const t = Date.parse(n.created_at);
          return Number.isFinite(t) && t >= startMs;
        });
        const highlights = mine.filter((n) => n.note_type === "Highlight").length;
        const tutor = mine.filter((n) => n.note_type === "TutorNote").length;
        const noteCount = mine.length - highlights - tutor;
        // Next session preview: the section after the furthest one reached.
        let maxIdx = currentIdx;
        assignableSections.forEach((s, i) => { if (visited.has(s.id) && i > maxIdx) maxIdx = i; });
        const nextLabel = assignableSections[maxIdx + 1]?.label ?? null;
        const recap: RecapData = { minutes, labels, highlights, noteCount, tutor, nextLabel };
        return (
          <EndingPanel
            rescue={rescue}
            recap={recap}
            summary={summary}
            setSummary={setSummary}
            onCancel={() => setEndingPrompt(false)}
            onSave={() => finalizeSession(summary)}
            onSkip={() => finalizeSession(null)}
          />
        );
      })()}
    </section>
  );
}

/**
 * Split section text into paragraphs on blank lines, and within each paragraph
 * collapse the single "soft-wrap" newlines that Project Gutenberg plain text
 * uses (every ~70 chars) into spaces so the browser reflows the prose to the
 * column width. Without this, `white-space` would render each source line as a
 * hard break — the text reads like free verse in a narrow window and strands
 * orphan words (e.g. "a particle") when a source line soft-wraps in a wide one.
 *
 * The newline→space swap is LENGTH-PRESERVING (1 char → 1 char), so the char
 * offsets that anchor highlights and selections stay exactly aligned with the
 * raw section text. Blank-line separators between paragraphs are consumed by the
 * split, so each chunk contains only intra-paragraph soft wraps.
 *
 * Exported for unit tests (offset alignment is load-bearing for marginalia).
 */
export interface Paragraph { offset: number; text: string; pre?: boolean }

/** Prose split+reflow on a slice, emitting offsets rebased by `base`. */
function splitProse(text: string, base: number): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /\n\s*\n+/g;
  const reflow = (s: string) => s.replace(/\n/g, " ");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = text.slice(last, m.index);
    if (chunk.trim().length > 0) out.push({ offset: base + last, text: reflow(chunk) });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const tail = text.slice(last);
    if (tail.trim().length > 0) out.push({ offset: base + last, text: reflow(tail) });
  }
  return out;
}

/**
 * Split section text into paragraphs. Prose paragraphs reflow soft-wrap newlines
 * to spaces (length-preserving, so char offsets stay aligned for marginalia). Any
 * `preRanges` (code blocks, in section-relative offsets) are emitted as single
 * NON-reflowed paragraphs marked `pre` so their newlines + indentation survive —
 * the reader renders those monospace. Offsets are always exact section offsets.
 *
 * Exported for unit tests (offset alignment is load-bearing for marginalia).
 */
export function splitParagraphs(
  text: string,
  preRanges: ReadonlyArray<{ start: number; end: number }> = [],
): Paragraph[] {
  const pres = preRanges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  if (pres.length === 0) return splitProse(text, 0);
  const out: Paragraph[] = [];
  let cursor = 0;
  for (const r of pres) {
    const s = Math.max(cursor, r.start);
    const e = Math.min(text.length, r.end);
    if (e <= s) continue;
    if (s > cursor) out.push(...splitProse(text.slice(cursor, s), cursor));
    out.push({ offset: s, text: text.slice(s, e), pre: true });
    cursor = e;
  }
  if (cursor < text.length) out.push(...splitProse(text.slice(cursor), cursor));
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

/** Geometry for the floating selection toolbar, in reader-relative px. The
 *  toolbar is rendered with `transform: translate(-50%, calc(-100% - 8px))`, so
 *  `x` is its CENTER and `y` is the selection's top edge (the toolbar sits just
 *  above it). Pure + exported so it can be unit-tested without a DOM.
 *
 *  Two real edge cases this guards:
 *   - selecting the first word of a line would put `x` near 0, and `-50%` would
 *     push half the toolbar off the left edge → clamp `x` so the toolbar's
 *     half-width stays inside `[0, readerWidth]`.
 *   - selecting the very top line leaves no room above it → when `y` is smaller
 *     than the toolbar height, flip the toolbar BELOW the selection and report
 *     `below: true` so the caller can drop the upward translate. */
/** Companion side-panel width bounds (px). Dragging the divider below MIN
 *  collapses the margin back to the clean reading column. */
export const MIN_PANEL_WIDTH = 200;
export const MAX_PANEL_WIDTH = 560;
export const DEFAULT_PANEL_WIDTH = 320;

/** Clamp the companion side-panel width to a sane range (px). Exported for the
 *  width persistence read + unit tests. */
export function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_PANEL_WIDTH;
  return Math.min(Math.max(Math.round(w), MIN_PANEL_WIDTH), MAX_PANEL_WIDTH);
}

/** Outcome of a resize drag at a proposed raw width (px from the window's right
 *  edge to the cursor). Below the minimum → collapse to the clean column;
 *  otherwise resize within bounds. */
export type PanelDrag = { kind: "collapse" } | { kind: "resize"; width: number };
export function panelDragOutcome(rawWidth: number): PanelDrag {
  if (!Number.isFinite(rawWidth) || rawWidth < MIN_PANEL_WIDTH) {
    return { kind: "collapse" };
  }
  return { kind: "resize", width: clampPanelWidth(rawWidth) };
}

export function clampToolbarPosition(
  rawX: number,
  rawY: number,
  readerWidth: number,
  opts: { toolbarWidth?: number; toolbarHeight?: number; selectionHeight?: number } = {},
): { x: number; y: number; below: boolean } {
  const tw = opts.toolbarWidth ?? 300;
  const th = opts.toolbarHeight ?? 40;
  const selH = opts.selectionHeight ?? 22;
  const half = tw / 2;
  // Keep the whole toolbar on screen even when readerWidth < toolbarWidth.
  const x = readerWidth >= tw
    ? Math.min(Math.max(rawX, half), readerWidth - half)
    : readerWidth / 2;
  // If there isn't room for the toolbar (+8px gap) above the selection, drop it
  // below the selected line instead of letting it clip off the top.
  const below = rawY < th + 8;
  const y = below ? rawY + selH : rawY;
  return { x, y, below };
}

/** Render a paragraph's text, composing anchored highlights with inline emphasis
 *  (bold/italic) from the structure sidecar. Offsets are within-section; the pure
 *  `segmentParagraph` flattens overlapping ranges into ordered runs (it only
 *  slices the string, never rewrites it, so char-offset anchoring is preserved).
 *  When nothing applies it returns the bare string — identical to the old reader. */
function renderParagraph(
  text: string,
  pOffset: number,
  highlights: Array<{ id: string; start: number; end: number }>,
  inlineSpans: StyleRange[],
  activeId: string | null,
  setActive: (id: string) => void,
): ReactNode {
  const segments = segmentParagraph(text, pOffset, highlights, inlineSpans);
  if (segments.length === 1 && !segments[0].hlId && !segments[0].strong && !segments[0].em) {
    return segments[0].text;
  }
  return segments.map((seg, i) => {
    if (!seg.hlId && !seg.strong && !seg.em) return seg.text;
    let node: ReactNode = seg.text;
    if (seg.em) node = <em>{node}</em>;
    if (seg.strong) node = <strong>{node}</strong>;
    if (seg.hlId) {
      const id = seg.hlId;
      node = (
        <mark
          className={activeId === id ? "tl-hl active" : "tl-hl"}
          onClick={(e) => { e.stopPropagation(); setActive(id); }}
        >
          {node}
        </mark>
      );
    }
    return <Fragment key={i}>{node}</Fragment>;
  });
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
  /** Stored with the note (plumbing) — never rendered; see positionHint. */
  locator: string;
  /** Reader-facing "32% in"-style position, or null when it adds nothing. */
  positionHint: string | null;
  onClose: () => void;
}) {
  const [noteType, setNoteType] = useState<string>("Reflection");
  const [body, setBody] = useState("");
  const [shortQuote, setShortQuote] = useState("");
  const [warn, setWarn] = useState(false);
  const [saving, setSaving] = useState(false);
  // A failed save is said out loud inside the modal (never a silent dead end);
  // the modal stays open so the reader's words survive and Save can be retried.
  const [saveErr, setSaveErr] = useState<string | null>(null);
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
    setSaveErr(null);
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
    } catch (e) {
      setSaveErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tl-modal-backdrop">
      <div ref={panelRef} className="tl-modal" role="dialog" aria-modal="true" aria-labelledby="text-note-panel-title">
        <div className="tl-modal-head">
          <span className="t" id="text-note-panel-title"><TLIcon name="pencil" size={16} /> New note</span>
          <button className="tl-iconbtn" onClick={props.onClose} aria-label="Close note panel"><TLIcon name="x" size={16} /></button>
        </div>

        <label>Type
          <select className="tl-select" value={noteType} onChange={(e) => setNoteType(e.target.value)}>
            {NOTE_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>

        <div className="row"><span>Chapter: {props.chapter}</span>{props.positionHint && <span>{props.positionHint}</span>}</div>

        <label>Note
          <textarea
            className="tl-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Paraphrase, reflection, or question…"
            autoFocus
          />
        </label>

        <label>Short quote (optional)
          <textarea
            className="tl-input"
            style={{ minHeight: 64, fontFamily: "var(--tl-serif)", resize: "vertical" }}
            value={shortQuote}
            onChange={(e) => setShortQuote(e.target.value)}
            placeholder="Keep it under ~300 characters"
          />
        </label>
        {warn && (
          <p className="tl-warn-text">
            Quote exceeds ~300 characters. Fair use has no fixed safe word count — the default
            posture in Throughline is short quotes for private study only. (Saving is still allowed.)
          </p>
        )}

        {saveErr && (
          <p className="tl-warn-text" role="alert">
            {saveErr} Your note is still here — try Save again, or check the export folder in Settings.
          </p>
        )}

        <div className="panel-actions">
          <button className="tl-btn tl-btn-ghost" onClick={props.onClose}>Cancel</button>
          <button className="tl-btn tl-btn-primary" disabled={saving || !body.trim()} onClick={save}>
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RecapData {
  minutes: number;
  labels: string[];
  highlights: number;
  noteCount: number;
  tutor: number;
  nextLabel: string | null;
}

/**
 * Session close = a recap, not a thin dialog: minutes read, sections finished,
 * counts of highlights/notes/tutor cards, an optional one-sentence takeaway the
 * reader can Accept/Edit/Skip, and a preview of next time. Rescue mode keeps the
 * "That counts" framing and never forces a takeaway or completion.
 */
function EndingPanel(props: {
  rescue?: boolean;
  recap: RecapData;
  summary: string;
  setSummary: (s: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, props.onCancel);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(props.summary.trim().length > 0);
  const { rescue, recap } = props;
  const hasTakeaway = props.summary.trim().length > 0;
  function startEditing() {
    setEditing(true);
    setTimeout(() => taRef.current?.focus(), 0);
  }
  return (
    <div className="tl-modal-backdrop">
      <div ref={panelRef} className="tl-modal tl-recap" role="dialog" aria-modal="true" aria-labelledby="text-ending-panel-title">
        <div className="tl-modal-head">
          <span className="t" id="text-ending-panel-title">
            <TLIcon name="flag" size={16} /> {rescue ? "That counts" : "Session recap"}
          </span>
          <button className="tl-iconbtn" onClick={props.onCancel} aria-label="Keep reading"><TLIcon name="x" size={16} /></button>
        </div>

        <div className="tl-recap-stats">
          <div className="tl-recap-stat"><span className="n">{recap.minutes}</span><span className="l">min read</span></div>
          <div className="tl-recap-stat"><span className="n">{recap.labels.length}</span><span className="l">section{recap.labels.length === 1 ? "" : "s"} done</span></div>
          <div className="tl-recap-stat"><span className="n">{recap.highlights}</span><span className="l">highlight{recap.highlights === 1 ? "" : "s"}</span></div>
          <div className="tl-recap-stat"><span className="n">{recap.noteCount}</span><span className="l">note{recap.noteCount === 1 ? "" : "s"}</span></div>
          <div className="tl-recap-stat"><span className="n">{recap.tutor}</span><span className="l">tutor card{recap.tutor === 1 ? "" : "s"}</span></div>
        </div>

        {recap.labels.length > 0 && (
          <p className="tl-recap-sections">Finished: {recap.labels.join(" · ")}</p>
        )}

        <div className="tl-recap-takeaway">
          <p className="prompt">
            {rescue
              ? "You stayed connected to the book today. Want to keep one line before you go? (Optional.)"
              : "One sentence you want to remember from today?"}
          </p>
          {editing ? (
            <textarea
              ref={taRef}
              className="tl-textarea"
              style={{ minHeight: 76 }}
              value={props.summary}
              autoFocus
              onChange={(e) => props.setSummary(e.target.value)}
              placeholder={rescue ? "Optional — or just skip." : "Your one line…"}
            />
          ) : hasTakeaway ? (
            <div className="tl-recap-saved">
              “{props.summary.trim()}”
              <button className="tl-linkbtn" onClick={startEditing}>Edit</button>
            </div>
          ) : null}
        </div>

        <p className="tl-recap-next">
          {recap.nextLabel ? <>Next time → <strong>{recap.nextLabel}</strong></> : "You've reached the last section. Beautifully done."}
        </p>

        <div className="panel-actions">
          <button className="tl-btn tl-btn-ghost" onClick={props.onCancel}>Keep reading</button>
          {!editing && !hasTakeaway && (
            <button className="tl-btn tl-btn-ghost" onClick={startEditing}>Add a takeaway</button>
          )}
          {hasTakeaway && (
            <button className="tl-btn tl-btn-ghost" onClick={props.onSkip}>Skip takeaway</button>
          )}
          <button className="tl-btn tl-btn-primary" onClick={hasTakeaway ? props.onSave : props.onSkip}>
            {rescue ? "That counts — done" : hasTakeaway ? "Save & finish" : "Finish"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Today from "./screens/Today";
import Reader from "./screens/Reader";
import Settings from "./screens/Settings";
import BookSwitcher from "./screens/BookSwitcher";
import NotesBrowser from "./screens/NotesBrowser";
import BookSetupSheet from "./screens/BookSetupSheet";
import Discover from "./screens/Discover";
import FrontDoor from "./screens/FrontDoor";
import Library from "./screens/Library";
import PlansView from "./components/PlansView";
import RePlanDialog from "./components/RePlanDialog";
import RemoveBookDialog from "./components/RemoveBookDialog";
import DataFolderMoment from "./components/DataFolderMoment";
import TLIcon from "./components/TLIcon";
import ThroughlineMark from "./components/ThroughlineMark";
import UpdateChecker from "./components/UpdateChecker";
import "./App.css";
import "./tl-theme.css";
import type { TodayCard, Book, ImportOutcome, ExportPathStatus, PlanSummary, Provenance, Note, SettingsDto } from "./types";
import { reconcileNoteDrafts, setDraftGeneration } from "./noteDrafts";
import { errorMessage } from "./types";
import { purgeLegacyBriefings } from "./sectionBriefing";
import { migrateLegacyLocalStorageKeys } from "./legacyStorage";
import { focusAfterUpdateRelaunchIfNeeded } from "./updateRelaunchFocus";
import { updateMachine } from "./updateMachine";
import {
  adjustFontSize,
  getCachedThemePref,
  loadAppearance,
  normalizeThemePref,
  resolveTheme,
  systemPrefersDark,
  toggleResolvedTheme,
  THEME_PREF_EVENT,
  type ThemePref,
} from "./appearance";

type BookTab = "today" | "library" | "notes";

/** How long the "{Title} removed · Undo" toast lingers before the removal is
 *  actually committed. During this window NOTHING is deleted — the book is only
 *  hidden — so undo is instant and the reading state (and a catalogue book's
 *  downloaded text) is always intact (handoff §3). */
const REMOVE_UNDO_MS = 8000;

/** One human line for a failed import — routed through errorMessage so a raw
 *  AppError ({kind:…}) never reaches the reader as JSON. Exported for tests. */
export function importErrorText(e: unknown): string {
  return `Import failed: ${errorMessage(e)}`;
}

/** Outcome of a file-drop import attempt. Exported for tests. */
export type DropResult =
  | { kind: "imported"; outcome: ImportOutcome }
  | { kind: "unsupported"; message: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

/** Import the first readable file from an OS drag-and-drop — the advertised
 *  "drag in a book" path, funneled through the SAME `cmd_import_book` (with its
 *  SHA dedup) the file picker uses. Anything that isn't .txt/.epub gets a calm
 *  message, never silence. Exported for tests; the caller routes the result. */
export async function handleDroppedPaths(paths: string[]): Promise<DropResult> {
  if (paths.length === 0) return { kind: "none" };
  const file = paths.find((p) => /\.(txt|epub)$/i.test(p));
  if (!file) {
    return { kind: "unsupported", message: "Throughline reads .txt and DRM-free .epub files." };
  }
  try {
    const outcome = await invoke<ImportOutcome>("cmd_import_book", { path: file });
    return { kind: "imported", outcome };
  } catch (e) {
    return { kind: "error", message: importErrorText(e) };
  }
}

type View =
  | { kind: "today" }
  | { kind: "reader"; today: TodayCard }
  // `createdByThisPick` is the back-nav undo guard (CORE-1142): true only when
  // THIS pick imported the book (file/drag/discover into a brand-new book), so
  // Back on the first setup screen may remove it. A new plan for an existing
  // book sets it false — Back then just returns, never deletes the book.
  | { kind: "setup"; book: Book; createdByThisPick: boolean }
  | { kind: "plans" }
  | { kind: "discover" }
  | { kind: "settings" };

export default function App() {
  const [today, setToday] = useState<TodayCard | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "today" });
  const [tab, setTab] = useState<BookTab>("today");
  // Bumped whenever the set of books / their progress changes, so the Library
  // tab re-fetches cmd_library. (Listing the library never mutates state, so a
  // re-fetch is cheap and never changes which book is active.)
  const [libraryKey, setLibraryKey] = useState(0);
  const bumpLibrary = () => setLibraryKey((k) => k + 1);
  // Theme preference (light | dark | auto). The cached pref paints the first
  // frame; the backend value (source of truth, loadAppearance) reconciles right
  // after. Auto follows macOS live via prefers-color-scheme.
  const [themePref, setThemePref] = useState<ThemePref>(getCachedThemePref);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);
  const theme = resolveTheme(themePref, systemDark);

  // Theme changes announced from anywhere (the Appearance pane, ⌘⇧L) — the
  // appearance module owns persistence; App owns applying the resolved theme.
  useEffect(() => {
    const onPref = (e: Event) => {
      const p = normalizeThemePref((e as CustomEvent).detail);
      if (p) setThemePref(p);
    };
    window.addEventListener(THEME_PREF_EVENT, onPref);
    return () => window.removeEventListener(THEME_PREF_EVENT, onPref);
  }, []);

  // R4 startup reconciliation: quarantine retained note drafts whose note no
  // longer exists (a deletion the quit-time launch sweep committed in Rust),
  // BEFORE any card can mount them — otherwise a later restore could bring
  // the note id back with a matching updated_at and silently resurrect
  // deleted words. Fire-and-forget; a failed lookup keeps drafts untouched.
  useEffect(() => {
    void (async () => {
      // R5: load the LIBRARY GENERATION first — reconciliation quarantines
      // drafts typed under a different generation (any restore/undo/recovery
      // since), even when a restored row's updated_at coincidentally matches.
      try {
        const s = await invoke<SettingsDto>("cmd_get_settings");
        setDraftGeneration(s.library_generation ?? "");
      } catch {
        setDraftGeneration(null); // unknown — reconcile on note existence only
      }
      await reconcileNoteDrafts((bookId) => invoke<Note[]>("cmd_list_notes", { bookId }));
    })();
  }, []);

  // Follow the system while on Auto (live, not just at launch).
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // Instant theme flip (brand rule: no crossfade). Suppress every transition for
  // one frame when data-theme changes — this also fixes the WKWebView quirk where
  // properties listed in a base `transition` (e.g. .tl-btn color/background) fail
  // to re-resolve their var(--token) values on a runtime [data-theme] flip, so
  // buttons keep the previous theme's colors (ghost text invisible in dark).
  const themeFirstRun = useRef(true);
  useEffect(() => {
    const root = document.documentElement;
    if (themeFirstRun.current) {
      themeFirstRun.current = false;
      root.dataset.theme = theme;
      return;
    }
    root.classList.add("tl-no-transition");
    root.dataset.theme = theme;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("tl-no-transition")));
  }, [theme]);

  // null = no load error. A string = the most recent cmd_today failure, which
  // would otherwise strand the app on "Loading…" forever with no way out.
  const [loadError, setLoadError] = useState<string | null>(null);

  // While the active book is mid-undo-window AND it was the last book (nothing to
  // fall through to), cmd_today still returns it — so we hide that one book id
  // here, showing the front door instead, until the window resolves. For every
  // other removal we switch the active book away first, so this stays null.
  const suppressBookIdRef = useRef<string | null>(null);

  async function refreshToday() {
    try {
      const t = await invoke<TodayCard | null>("cmd_today");
      const hidden = suppressBookIdRef.current;
      setToday(t && hidden && t.book.id === hidden ? null : (t ?? null));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
    // Keep the Library shelf in step with any book/plan/progress change.
    bumpLibrary();
  }

  useEffect(() => {
    void focusAfterUpdateRelaunchIfNeeded();
    refreshToday();
    // One-time cleanup: builds before v0.3.x persisted Deep Study briefings in
    // localStorage. The counsel posture (CLAUDE.md §3) is "non-persistent
    // unless saved", so remove any leftovers — the live cache is in-memory.
    purgeLegacyBriefings();
    // One-time rename shim (CORE-1031): carry pre-rename preference keys (tutor
    // consent, font size, panel state) over to their tl.* twins, then drop them.
    migrateLegacyLocalStorageKeys();
    // Appearance: adopt the backend's stored theme (or seed it from the legacy
    // key, once) and apply the reading typeface + line spacing.
    void loadAppearance().then(setThemePref);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Global keyboard shortcuts (Settings › Shortcuts is their reference) ──
  // ⌘, Settings · ⌘⇧L toggle theme · ⌘K search the library · ⌘+/⌘− text size.
  // ⌘E and ⌘N are reader-scoped and live in TextReader. Chords only — plain
  // keys are never intercepted, so typing is untouched.
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ",") {
        e.preventDefault();
        setView({ kind: "settings" });
      } else if (e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        toggleResolvedTheme();
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setView({ kind: "today" });
        setTab("library");
        setSearchFocusKey((k) => k + 1);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        adjustFontSize(+1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        adjustFontSize(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Activation feedback (CORE-1009): the deep link is the buyer's
  // highest-anxiety moment — "did my $20 purchase take?" — so both outcomes
  // get a visible, dismissable banner instead of silence.
  const [activation, setActivation] = useState<{ ok: boolean; message: string } | null>(null);

  // Company-mode activation deep link (CM5). throughline://activate?token=… →
  // the Rust handler emits "tl-activate"; we exchange it for a license here. The
  // dynamic import + try/catch makes this a no-op outside Tauri (the harness).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("tl-activate", async (e) => {
          try {
            await invoke("cmd_activate_company", { activationToken: e.payload });
            setTab("today");
            await refreshToday();
            setActivation({ ok: true, message: "Throughline AI is active — ask the tutor anything." });
            // If Settings is already open, it must catch up without a remount.
            window.dispatchEvent(new Event("tl-company-activated"));
          } catch (err) {
            setActivation({ ok: false, message: errorMessage(err) });
          }
        });
      } catch {
        /* not running under Tauri — nothing to listen to */
      }
    })();
    return () => unlisten?.();
  }, []);

  // The macOS app-menu "Check for Updates…" item (CORE-1193). The Rust menu
  // handler focuses the window and emits this event; we land the reader on the
  // Settings Software Update section and start a MANUAL check (never gated by
  // the automatic cooldown — the machine no-ops it if an update is already
  // mid-download or waiting on a restart). The window event mirrors the Tauri
  // one for the browser harness (same idiom as tl-company-activated).
  const [jumpToUpdate, setJumpToUpdate] = useState(false);
  useEffect(() => {
    const onCheckForUpdates = () => {
      setView({ kind: "settings" });
      setJumpToUpdate(true);
      void updateMachine.manualCheck();
    };
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen("tl-menu-check-updates", onCheckForUpdates);
      } catch {
        /* not running under Tauri — nothing to listen to */
      }
    })();
    window.addEventListener("tl-menu-check-updates", onCheckForUpdates);
    return () => {
      unlisten?.();
      window.removeEventListener("tl-menu-check-updates", onCheckForUpdates);
    };
  }, []);

  // Refresh Today when a phrase-cache change is signalled. Background phrase
  // GENERATION was removed (PRIV-001) — the backend no longer emits this event;
  // previously cached phrases still display, and the window event remains as
  // the browser harness's hook for exercising the slot's zero-CLS swap.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen("tl-phrases-updated", () => {
          refreshToday();
        });
      } catch {
        /* not running under Tauri — nothing to listen to */
      }
    })();
    const onWin = () => refreshToday();
    window.addEventListener("tl-phrases-updated", onWin);
    return () => {
      unlisten?.();
      window.removeEventListener("tl-phrases-updated", onWin);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The calm dismissable notice banner. It carries every "that didn't work"
  // moment — a refused drop, a failed import, a book that wouldn't switch, a
  // plan that wouldn't start. It must be in-app: window.alert is a dead
  // channel in the shipped WKWebView (no alert panel is wired up), so anything
  // sent there vanishes without a trace (CORE-1041).
  const [notice, setNotice] = useState<string | null>(null);

  // Drag a book in (golden loop, first link). The webview intercepts OS file
  // drops; .txt/.epub routes through the same import + setup flow as the file
  // picker, anything else gets the notice banner. The dynamic import +
  // try/catch makes this a no-op outside Tauri (the test harness / a browser).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type !== "drop") return;
          const result = await handleDroppedPaths(event.payload.paths);
          if (result.kind === "imported") {
            setNotice(null);
            await refreshToday();
            // Same routing as importBook: genuinely new → Book Setup Sheet;
            // a dedup just lands on Today as the active book.
            setView(result.outcome.created ? { kind: "setup", book: result.outcome.book, createdByThisPick: true } : { kind: "today" });
            // A dragged-in own file is the same "first import" trigger.
            if (result.outcome.created) void maybeShowDataFolderMoment();
          } else if (result.kind === "unsupported" || result.kind === "error") {
            setNotice(result.message);
          }
        });
      } catch {
        /* not running under Tauri — nothing to listen to */
      }
    })();
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Export-folder preflight: catch a misconfigured path or an unmounted drive on
  // launch, BEFORE a session's notes are silently lost. A calm banner, not a block.
  const [exportWarning, setExportWarning] = useState<string | null>(null);
  useEffect(() => {
    invoke<ExportPathStatus>("cmd_check_export_path")
      .then((s) => setExportWarning(s.writable ? null : (s.message ?? "Throughline can't save notes to the export folder.")))
      .catch(() => {});
  }, [view.kind]);

  async function importBook() {
    const file = await openDialog({
      multiple: false,
      filters: [
        { name: "Books", extensions: ["txt", "epub"] },
        { name: "Plain text", extensions: ["txt"] },
        { name: "EPUB", extensions: ["epub"] },
      ],
    });
    if (!file) return;
    const path = typeof file === "string" ? file : (file as any).path;
    let outcome: ImportOutcome;
    try {
      outcome = await invoke<ImportOutcome>("cmd_import_book", { path });
    } catch (e) {
      // Backend returns AppError: { kind, message }. errorMessage turns any
      // shape into a human sentence — never raw JSON in the banner.
      setNotice(importErrorText(e));
      return;
    }
    await refreshToday();
    // A genuinely new book opens the Book Setup Sheet so the reader can set a
    // rhythm before the first session. A dedup (switch to existing) just lands
    // on Today.
    if (outcome.created) {
      setView({ kind: "setup", book: outcome.book, createdByThisPick: true });
      // First own-file import → the one-time data-folder moment (never for the
      // catalogue path).
      void maybeShowDataFolderMoment();
    }
  }

  // The public-domain catalogue. Reached from the Welcome card and the
  // book-switcher menu; "Cancel" returns to Today.
  function openDiscover() {
    setView({ kind: "discover" });
  }

  // A book finished downloading from the catalogue. A genuinely new book opens
  // the Book Setup Sheet (seeded with it); a dedup just lands on Today as the
  // active book — mirrors the file-picker import outcome exactly.
  async function onDiscoverPick(outcome: ImportOutcome) {
    await refreshToday();
    setView(outcome.created ? { kind: "setup", book: outcome.book, createdByThisPick: true } : { kind: "today" });
  }

  // Leaving the setup sheet: "Begin reading" goes straight into the first
  // sitting (the design's promise — no plan-summary detour); the quiet link
  // lands on Today. Either way the fresh card is fetched first.
  async function finishSetup(begin: boolean) {
    let t: TodayCard | null = null;
    try {
      t = (await invoke<TodayCard | null>("cmd_today")) ?? null;
      setToday(t);
      setLoadError(null);
    } catch (e) {
      // loadError only renders before the first card; once a book is on the
      // desk the dismissable banner is the visible channel for this failure.
      setNotice(`Couldn't open the book: ${errorMessage(e)}`);
    }
    if (begin && t && t.section) {
      setView({ kind: "reader", today: t });
    } else {
      setView({ kind: "today" });
    }
  }

  // Back out of the first setup screen (CORE-1142). This is an UNDO of the pick,
  // never a confirmed delete: when this pick is what imported the book, remove it
  // and recompute Today (an empty library recomputes to null → the front door);
  // otherwise (a new plan for a book already on the shelf) just return to Today,
  // leaving the book untouched. The created-by-this-pick guard lives HERE, at the
  // call site — cmd_delete_book itself never guards.
  async function exitSetup(book: Book, createdByThisPick: boolean) {
    if (createdByThisPick) {
      try {
        await invoke("cmd_delete_book", { bookId: book.id });
      } catch (e) {
        // A failed undo must not strand the reader on setup; surface it calmly
        // and still return to Today, where the book remains until they retry.
        setNotice(`Couldn't undo that: ${errorMessage(e)}`);
      }
      await refreshToday();
    }
    setView({ kind: "today" });
  }

  // "Remove from library" (CORE-1093 / handoff §3): a deliberate, CONFIRMED
  // removal with a brief undo window. `removeTarget` drives the source-specific
  // confirmation dialog; `pendingRemoval` is the book hidden during its undo
  // window. The real `cmd_delete_book` (a hard cascade) fires ONLY when the
  // window elapses — so during the window nothing is deleted, undo is instant
  // (it just cancels the timer), and a catalogue book's downloaded text is kept
  // exactly as the design requires.
  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    title: string;
    provenance: Provenance;
  } | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{ id: string; title: string } | null>(null);
  // R4: a failed Undo-unstage, announced inside the toast (Undo = retry).
  const [removalUndoIssue, setRemovalUndoIssue] = useState<string | null>(null);
  const removalTimer = useRef<number | null>(null);
  const removalWasActiveRef = useRef(false);

  // The one-time data-folder moment (handoff §6): non-null path = the calm card
  // is open. Shown ONCE, the first time a reader imports their OWN file
  // (catalogue-only readers never see it). The "already shown" flag lives in
  // localStorage and is written only when the card is actually shown, so a
  // default read can never re-trigger it; it never recurs and never nags.
  const [dataFolder, setDataFolder] = useState<string | null>(null);
  async function maybeShowDataFolderMoment() {
    if (localStorage.getItem("tl.dataFolderSeen")) return;
    try {
      const info = await invoke<{ app_support: string }>("cmd_paths_info");
      localStorage.setItem("tl.dataFolderSeen", "1");
      setDataFolder(info.app_support);
    } catch {
      // Can't resolve the path → don't show a broken card and don't burn the
      // one-time flag; the next own-file import tries again.
    }
  }

  // Open the confirmation for a book, with the provenance the caller already
  // knows (the shelf, switcher, and detail view all carry it) so the dialog
  // shows the right loss.
  function requestRemove(id: string, title: string, provenance: Provenance) {
    setRemoveTarget({ id, title, provenance });
  }

  // The most-recently-opened OTHER book — where Today falls through to when the
  // book being removed is the active one (mirrors the backend's active selector).
  async function mostRecentOtherBook(excludeId: string): Promise<string | null> {
    try {
      const books = await invoke<Book[]>("cmd_list_books");
      const others = books.filter((b) => b.id !== excludeId);
      if (others.length === 0) return null;
      others.sort((a, b) => {
        const ax = a.last_opened_at ?? a.created_at;
        const bx = b.last_opened_at ?? b.created_at;
        return ax < bx ? 1 : ax > bx ? -1 : 0;
      });
      return others[0].id;
    } catch {
      return null;
    }
  }

  // Commit any in-flight removal to a real delete immediately — used before
  // starting a new one (one undo window at a time) and on unmount, so a hidden
  // book never lingers undeleted.
  async function flushPendingRemoval() {
    if (removalTimer.current) {
      clearTimeout(removalTimer.current);
      removalTimer.current = null;
    }
    const p = pendingRemoval;
    if (!p) return;
    setPendingRemoval(null);
    suppressBookIdRef.current = null;
    removalWasActiveRef.current = false;
    try {
      await invoke("cmd_delete_book", { bookId: p.id });
    } catch {
      /* best-effort; a failed delete just leaves the book in place */
    }
  }

  // Confirmed Remove: durably stage the removal FIRST, and only then hide the
  // book and start the undo window. Removing the book on Today moves "active"
  // to the next book first (or, if it was the last book, suppresses it so
  // Today shows the front door) — so the shelf, switcher, and Today never
  // point at a book that's mid-removal.
  async function confirmRemoveBook() {
    const target = removeTarget;
    if (!target) return;
    setRemoveTarget(null);

    // DATA-005: the durable stage is AWAITED before anything is hidden. If it
    // fails, nothing changed — the book stays visible, no Undo window opens,
    // and the reader is told (a hidden book whose staging silently failed
    // would resurrect on relaunch after the toast said "removed"). Because the
    // Undo toast only exists after staging succeeded, Undo can never race an
    // in-flight stage call.
    try {
      await invoke("cmd_stage_book_delete", { bookId: target.id });
    } catch (e) {
      setNotice(`Couldn't remove that book (${errorMessage(e)}). It's still in your library — try again.`);
      return;
    }

    await flushPendingRemoval();

    const isActive = today != null && today.book.id === target.id;
    removalWasActiveRef.current = isActive;
    setView({ kind: "today" });

    if (isActive) {
      const fallback = await mostRecentOtherBook(target.id);
      if (fallback) {
        try {
          await invoke("cmd_set_active_book", { bookId: fallback });
        } catch {
          /* keep going; refreshToday still reflects the best available book */
        }
        suppressBookIdRef.current = null;
      } else {
        suppressBookIdRef.current = target.id;
      }
    }

    setRemovalUndoIssue(null); // a fresh toast never wears a stale undo error
    setPendingRemoval({ id: target.id, title: target.title });
    await refreshToday();

    if (removalTimer.current) clearTimeout(removalTimer.current);
    removalTimer.current = window.setTimeout(() => {
      void commitRemoval(target.id);
    }, REMOVE_UNDO_MS);
  }

  // The window elapsed: actually delete (the hard cascade), then recompute.
  async function commitRemoval(id: string) {
    removalTimer.current = null;
    setPendingRemoval(null);
    suppressBookIdRef.current = null;
    removalWasActiveRef.current = false;
    try {
      await invoke("cmd_delete_book", { bookId: id });
    } catch (e) {
      setNotice(`Couldn't remove that book: ${errorMessage(e)}`);
    }
    await refreshToday();
  }

  // Undo within the window: nothing was deleted, so restoring is just un-hiding
  // the book — and re-activating it if it was the book on Today, dropping the
  // reader back exactly where they were.
  //
  // R4: the unstage is AWAITED and failure-visible. The book stays hidden and
  // the Undo toast stays up until the unstage DURABLY succeeds — un-hiding on
  // a failed unstage told the reader "it's back" while the relaunch sweep
  // would still remove it. On failure the toast announces it and Undo becomes
  // the retry.
  const undoRemovalInFlight = useRef(false);
  async function undoRemoval() {
    const p = pendingRemoval;
    if (!p || undoRemovalInFlight.current) return;
    if (removalTimer.current) {
      clearTimeout(removalTimer.current);
      removalTimer.current = null;
    }
    undoRemovalInFlight.current = true;
    try {
      await invoke("cmd_unstage_book_delete", { bookId: p.id });
    } catch (e) {
      setRemovalUndoIssue(`Couldn't undo that (${errorMessage(e)}). Try again.`);
      return;
    } finally {
      undoRemovalInFlight.current = false;
    }
    setRemovalUndoIssue(null);
    setPendingRemoval(null);
    suppressBookIdRef.current = null;
    const wasActive = removalWasActiveRef.current;
    removalWasActiveRef.current = false;
    if (wasActive) {
      try {
        await invoke("cmd_set_active_book", { bookId: p.id });
      } catch {
        /* still un-hidden even if re-activation fails */
      }
    }
    await refreshToday();
  }

  // Clear a live undo timer on unmount (it would otherwise fire after teardown).
  useEffect(() => () => {
    if (removalTimer.current) clearTimeout(removalTimer.current);
  }, []);

  // Switch to a library book and continue reading it (the shelf tap and the
  // switcher's "Continue reading"). Drops into the reader when there's a place
  // to resume, else lands on Today.
  async function openLibraryBook(bookId: string) {
    try {
      await invoke("cmd_set_active_book", { bookId });
    } catch (e) {
      setNotice(`Could not open that book: ${errorMessage(e)}`);
      return;
    }
    let t: TodayCard | null = null;
    try {
      t = (await invoke<TodayCard | null>("cmd_today")) ?? null;
      setToday(t);
      bumpLibrary();
    } catch (e) {
      setNotice(`Could not open that book: ${errorMessage(e)}`);
      return;
    }
    if (t && t.section) {
      setView({ kind: "reader", today: t });
    } else {
      setView({ kind: "today" });
      setTab("today");
    }
  }

  async function switchBook(bookId: string) {
    try {
      await invoke("cmd_set_active_book", { bookId });
    } catch (e) {
      // errorMessage turns any AppError shape into a human sentence — a
      // message-less error must never surface as "[object Object]".
      setNotice(`Could not switch book: ${errorMessage(e)}`);
      return;
    }
    await refreshToday();
  }

  function startReading(t: TodayCard) {
    setView({ kind: "reader", today: t });
  }

  // "Start a new plan" (from the Plans view): create a fresh plan for the book —
  // the caller has already handled the old one (keep / pause / replace) — and open
  // its setup so the reader sets the pace + names it.
  async function newPlan(book: Book) {
    try {
      await invoke("cmd_start_new_plan", { bookId: book.id });
    } catch (e) {
      setNotice(`Could not start a new plan: ${errorMessage(e)}`);
      return;
    }
    // A new plan for a book already in the library — Back must NOT delete it.
    setView({ kind: "setup", book, createdByThisPick: false });
  }

  function exitReader() {
    setView({ kind: "today" });
    refreshToday();
  }

  // "Start a new plan" from the manage-plans view: a live plan gets the calm
  // keep / pause / replace decision first; a plan-less book goes straight to
  // the one-question setup.
  const [replanActive, setReplanActive] = useState<PlanSummary | null>(null);
  async function startNewPlanFlow(book: Book) {
    const active = await invoke<PlanSummary | null>("cmd_get_active_plan", { bookId: book.id }).catch(() => null);
    if (active) setReplanActive(active);
    else await newPlan(book);
  }

  if (today === undefined) {
    // A failed initial load gets an honest error + retry, never an endless spinner.
    if (loadError && today === undefined) {
      return (
        <main className="app tl-root" id="main-content" data-theme={theme}>
          <div className="tl-welcome">
            <div className="tl-welcome-card">
              <div className="mark"><TLIcon name="behind" size={26} /></div>
              <h1>Couldn’t open your library</h1>
              <p>Throughline couldn’t read its data just now. Your books and notes are safe on disk.</p>
              <button className="tl-btn tl-btn-primary" style={{ margin: "0 auto" }} onClick={() => { setLoadError(null); refreshToday(); }}>
                <TLIcon name="refresh" size={18} /> Try again
              </button>
              <div className="hint">{loadError}</div>
            </div>
          </div>
        </main>
      );
    }
    return (
      <main className="app tl-root" id="main-content">
        <p className="tl-note-meta" style={{ padding: "var(--tl-7)" }}>Loading…</p>
      </main>
    );
  }

  // Throughline opens to Today — no forced first-run AI chooser. The app is fully
  // usable without AI; setup happens at the moment of intent (the first tutor lens
  // click, via AiSetupSheet), where the privacy decision actually matters and the
  // reader has a passage in hand. There is no implicit default and nothing AI runs
  // until the reader selects a passage and asks.
  return (
    <div className="app tl-root" data-theme={theme}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header className="tl-titlebar" data-tauri-drag-region>
        <button className="tl-brand" onClick={() => setView({ kind: "today" })} aria-label="Throughline — home">
          <ThroughlineMark className="tl-brand-mark" size={20} />
          <span>Through<b>line</b></span>
        </button>
        <div className="tl-titlebar-spacer" data-tauri-drag-region />
        <button
          className={view.kind === "settings" ? "tl-iconbtn active" : "tl-iconbtn"}
          onClick={() => setView(view.kind === "settings" ? { kind: "today" } : { kind: "settings" })}
          title="Settings"
          aria-label="Settings"
          aria-pressed={view.kind === "settings"}
        >
          <TLIcon name="settings" size={18} />
        </button>
      </header>

      {activation && (
        <div
          className={activation.ok ? "tl-activation-banner ok" : "tl-activation-banner"}
          role={activation.ok ? "status" : "alert"}
        >
          <TLIcon name={activation.ok ? "check" : "behind"} size={16} />
          <span>
            {activation.message}
            {!activation.ok && " You can enter your activation code in Settings → Reading assistant."}
          </span>
          {!activation.ok && (
            <button
              className="tl-btn-quiet"
              onClick={() => { setActivation(null); setView({ kind: "settings" }); }}
            >
              Open Settings
            </button>
          )}
          <button className="tl-btn-quiet" onClick={() => setActivation(null)}>Dismiss</button>
        </div>
      )}

      {exportWarning && (
        <div className="tl-export-warning" role="alert">
          <TLIcon name="behind" size={16} />
          <span>{exportWarning} Your reading is safe — new notes just won't export until you choose a folder.</span>
          <button className="tl-btn-quiet" onClick={() => setView({ kind: "settings" })}>Choose a folder</button>
        </div>
      )}

      {notice && (
        <div className="tl-export-warning" role="alert">
          <TLIcon name="behind" size={16} />
          <span>{notice}</span>
          <button className="tl-btn-quiet" onClick={() => setNotice(null)}>OK</button>
        </div>
      )}

      <main id="main-content">
        {view.kind === "today" && (
          today === null ? (
            // No books yet — the front door owns book acquisition; no book chrome.
            // It begins the cover-thread (the three starter covers) and carries
            // the quiet activation whisper. Browse + Import + a starter pick all
            // route through the same flows the rest of the app uses.
            <FrontDoor onDiscover={openDiscover} onImport={importBook} onPicked={onDiscoverPick} />
          ) : (
            <>
              <div className="tl-bookhead">
                <div className="tl-bookhead-inner">
                  <BookSwitcher
                    activeBook={today.book}
                    refreshKey={libraryKey}
                    pendingRemovalId={pendingRemoval?.id ?? null}
                    onSwitch={switchBook}
                    onOpenLibrary={() => setTab("library")}
                    onShowInLibrary={() => setTab("library")}
                    onContinueReading={openLibraryBook}
                    onDiscover={openDiscover}
                    onImport={importBook}
                    onRemoveBook={(e) => requestRemove(e.id, e.title, e.provenance)}
                  />
                  <div className="tl-seg" role="tablist" aria-label="View">
                    <button
                      role="tab" id="tab-today" aria-label="Today"
                      aria-selected={tab === "today"} aria-controls="book-panel"
                      onClick={() => setTab("today")}
                    >
                      <span className="tl-seg-ico" aria-hidden="true"><TLIcon name="book" size={16} /></span>
                      <span className="tl-seg-label">Today</span>
                    </button>
                    <button
                      role="tab" id="tab-library" aria-label="Library"
                      aria-selected={tab === "library"} aria-controls="book-panel"
                      onClick={() => setTab("library")}
                    >
                      <span className="tl-seg-ico" aria-hidden="true"><TLIcon name="columns" size={16} /></span>
                      <span className="tl-seg-label">Library</span>
                    </button>
                    <button
                      role="tab" id="tab-notes" aria-label="Notes"
                      aria-selected={tab === "notes"} aria-controls="book-panel"
                      onClick={() => setTab("notes")}
                    >
                      <span className="tl-seg-ico" aria-hidden="true"><TLIcon name="note" size={16} /></span>
                      <span className="tl-seg-label">Notes</span>
                    </button>
                  </div>
                </div>
              </div>
              <div
                className="tl-body"
                id="book-panel"
                role="tabpanel"
                aria-labelledby={tab === "today" ? "tab-today" : tab === "library" ? "tab-library" : "tab-notes"}
              >
                {tab === "today" ? (
                  <Today today={today} onDiscover={openDiscover} onImport={importBook} onStart={startReading} onNewPlan={newPlan} onReviewNotes={() => setTab("notes")} onPlans={() => setView({ kind: "plans" })} />
                ) : tab === "library" ? (
                  <Library
                    today={today}
                    refreshKey={libraryKey}
                    searchFocusKey={searchFocusKey}
                    pendingRemovalId={pendingRemoval?.id ?? null}
                    onContinueReading={() => startReading(today)}
                    onOpenBook={openLibraryBook}
                    onRequestRemove={(entry) => requestRemove(entry.id, entry.title, entry.provenance)}
                    onBrowse={openDiscover}
                    onImport={importBook}
                  />
                ) : (
                  <NotesBrowser book={today.book} />
                )}
              </div>
            </>
          )
        )}
        {view.kind === "reader" && (
          <Reader today={view.today} onExit={exitReader} />
        )}
        {view.kind === "setup" && (
          <BookSetupSheet
            book={view.book}
            onDone={finishSetup}
            onBack={() => { void exitSetup(view.book, view.createdByThisPick); }}
          />
        )}
        {view.kind === "plans" && today && (
          <PlansView
            bookId={today.book.id}
            bookTitle={today.book.title}
            bookAuthor={today.book.author}
            today={today}
            onClose={() => setView({ kind: "today" })}
            onContinueReading={() => startReading(today)}
            onStartNewPlan={() => { void startNewPlanFlow(today.book); }}
            onChanged={refreshToday}
            onRelinked={refreshToday}
            onRemoveBook={(provenance) => requestRemove(today.book.id, today.book.title, provenance)}
          />
        )}
        {removeTarget && (
          <RemoveBookDialog
            title={removeTarget.title}
            provenance={removeTarget.provenance}
            onKeep={() => setRemoveTarget(null)}
            onRemove={() => { void confirmRemoveBook(); }}
          />
        )}
        {pendingRemoval && (
          // The brief, quiet undo. Announced politely; its action is keyboard-
          // reachable for the whole window. Nothing has actually been deleted
          // yet — Undo simply cancels the pending commit. A FAILED undo is
          // announced in place and the button becomes the retry (R4): the
          // toast never clears until the unstage durably succeeded.
          <div
            className="tl-undo-toast"
            role={removalUndoIssue ? "alert" : "status"}
            aria-live={removalUndoIssue ? "assertive" : "polite"}
          >
            <span className="tl-undo-msg">
              {removalUndoIssue ?? `${pendingRemoval.title} removed from your library.`}
            </span>
            <button type="button" className="tl-undo-btn" onClick={() => { void undoRemoval(); }}>
              {removalUndoIssue ? "Retry undo" : "Undo"}
            </button>
          </div>
        )}
        {dataFolder && (
          <DataFolderMoment path={dataFolder} onClose={() => setDataFolder(null)} />
        )}
        {replanActive && today && (
          <RePlanDialog
            bookTitle={today.book.title}
            planName={replanActive.name}
            progressLine={today.fraction_complete > 0 ? `${Math.round(today.fraction_complete * 100)}% through` : null}
            onCancel={() => setReplanActive(null)}
            onResolve={async (choice) => {
              const active = replanActive;
              setReplanActive(null);
              if (choice === "keep") { setView({ kind: "today" }); return; }
              if (choice === "pause") await invoke("cmd_pause_plan", { planId: active.id }).catch(() => {});
              else await invoke("cmd_archive_plan", { planId: active.id }).catch(() => {});
              await newPlan(today.book);
            }}
          />
        )}
        {view.kind === "discover" && (
          <Discover onBack={() => setView({ kind: "today" })} onPicked={onDiscoverPick} />
        )}
        {view.kind === "settings" && (
          <Settings jumpToUpdate={jumpToUpdate} onJumpConsumed={() => setJumpToUpdate(false)} />
        )}
      </main>
      <UpdateChecker visible={view.kind === "today" && (today === null || tab === "today")} />
    </div>
  );
}

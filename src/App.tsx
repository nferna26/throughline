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
import TLIcon from "./components/TLIcon";
import ThroughlineMark from "./components/ThroughlineMark";
import "./App.css";
import "./tl-theme.css";
import type { TodayCard, Book, ImportOutcome, ExportPathStatus } from "./types";
import { errorMessage } from "./types";
import { purgeLegacyBriefings } from "./sectionBriefing";
import { migrateLegacyLocalStorageKeys } from "./legacyStorage";

type BookTab = "today" | "notes";

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
  | { kind: "setup"; book: Book }
  | { kind: "discover" }
  | { kind: "settings" };

export default function App() {
  const [today, setToday] = useState<TodayCard | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "today" });
  const [tab, setTab] = useState<BookTab>("today");
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("tl.theme") as "light" | "dark") || "light"
  );

  // Instant theme flip (brand rule: no crossfade). Suppress every transition for
  // one frame when data-theme changes — this also fixes the WKWebView quirk where
  // properties listed in a base `transition` (e.g. .tl-btn color/background) fail
  // to re-resolve their var(--token) values on a runtime [data-theme] flip, so
  // buttons keep the previous theme's colors (ghost text invisible in dark).
  const themeFirstRun = useRef(true);
  useEffect(() => {
    const root = document.documentElement;
    localStorage.setItem("tl.theme", theme);
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

  async function refreshToday() {
    try {
      const t = await invoke<TodayCard | null>("cmd_today");
      setToday(t ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }

  useEffect(() => {
    refreshToday();
    // One-time cleanup: builds before v0.3.x persisted Deep Study briefings in
    // localStorage. The counsel posture (CLAUDE.md §3) is "non-persistent
    // unless saved", so remove any leftovers — the live cache is in-memory.
    purgeLegacyBriefings();
    // One-time rename shim (CORE-1031): carry pre-rename preference keys (tutor
    // consent, font size, panel state) over to their tl.* twins, then drop them.
    migrateLegacyLocalStorageKeys();
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
            setView(result.outcome.created ? { kind: "setup", book: result.outcome.book } : { kind: "today" });
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
      setView({ kind: "setup", book: outcome.book });
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
    setView(outcome.created ? { kind: "setup", book: outcome.book } : { kind: "today" });
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
      setLoadError(errorMessage(e));
    }
    if (begin && t && t.section) {
      setView({ kind: "reader", today: t });
    } else {
      setView({ kind: "today" });
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
    setView({ kind: "setup", book });
  }

  function exitReader() {
    setView({ kind: "today" });
    refreshToday();
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
        <button
          className="tl-iconbtn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          <TLIcon name={theme === "dark" ? "sun" : "moon"} size={18} />
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
            {!activation.ok && " You can enter your activation code in Settings → Assistance."}
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
            // No books yet — the welcome card owns book acquisition; no book chrome.
            <Today today={null} onDiscover={openDiscover} onImport={importBook} onStart={startReading} onRefresh={refreshToday} onNewPlan={newPlan} onReviewNotes={() => setTab("notes")} />
          ) : (
            <>
              <div className="tl-bookhead">
                <div className="tl-bookhead-inner">
                  <BookSwitcher activeBook={today.book} onSwitch={switchBook} onDiscover={openDiscover} onImport={importBook} />
                  <div className="tl-seg" role="tablist" aria-label="View">
                    <button
                      role="tab" id="tab-today"
                      aria-selected={tab === "today"} aria-controls="book-panel"
                      onClick={() => setTab("today")}
                    >
                      Today
                    </button>
                    <button
                      role="tab" id="tab-notes"
                      aria-selected={tab === "notes"} aria-controls="book-panel"
                      onClick={() => setTab("notes")}
                    >
                      Notes
                    </button>
                  </div>
                </div>
              </div>
              <div
                className="tl-body"
                id="book-panel"
                role="tabpanel"
                aria-labelledby={tab === "today" ? "tab-today" : "tab-notes"}
              >
                {tab === "today" ? (
                  <Today today={today} onDiscover={openDiscover} onImport={importBook} onStart={startReading} onRefresh={refreshToday} onNewPlan={newPlan} onReviewNotes={() => setTab("notes")} />
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
          <BookSetupSheet book={view.book} onDone={finishSetup} />
        )}
        {view.kind === "discover" && (
          <Discover onBack={() => setView({ kind: "today" })} onPicked={onDiscoverPick} />
        )}
        {view.kind === "settings" && <Settings />}
      </main>
    </div>
  );
}

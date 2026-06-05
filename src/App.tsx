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
import Onboarding from "./screens/Onboarding";
import TLIcon from "./components/TLIcon";
import "./App.css";
import "./tl-theme.css";
import type { TodayCard, ReaderMode, Book, ImportOutcome, SettingsDto } from "./types";
import { errorMessage } from "./types";

type BookTab = "today" | "notes";

type View =
  | { kind: "today" }
  | { kind: "reader"; today: TodayCard; mode: ReaderMode }
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
  // AI onboarding gate: null = unknown (loading), false = must choose a provider
  // before the app is usable, true = chosen (or explicitly declined).
  const [aiChosen, setAiChosen] = useState<boolean | null>(null);

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

  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings")
      .then((s) => setAiChosen(s.ai_provider_chosen))
      .catch(() => setAiChosen(true)); // never trap the reader if settings can't load
  }, []);

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
  }, []);

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
    } catch (e: any) {
      // Backend returns AppError: { kind, message }. Fall back to String(e) for
      // anything else (network errors thrown by tauri-api itself, etc.).
      const msg = e?.message ?? (typeof e === "string" ? e : JSON.stringify(e));
      alert(`Import failed: ${msg}`);
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

  function finishSetup() {
    setView({ kind: "today" });
    refreshToday();
  }

  async function switchBook(bookId: string) {
    try {
      await invoke("cmd_set_active_book", { bookId });
    } catch (e: any) {
      alert(`Could not switch book: ${e?.message ?? e}`);
      return;
    }
    await refreshToday();
  }

  function startReading(t: TodayCard) {
    setView({ kind: "reader", today: t, mode: "full" });
  }

  // The "I only have 10 minutes" path — same reader, calm framing, no pace
  // pressure. Opens at the saved resume position (the next paragraph).
  function startRescue(t: TodayCard) {
    setView({ kind: "reader", today: t, mode: "rescue" });
  }

  function exitReader() {
    setView({ kind: "today" });
    refreshToday();
  }

  if (today === undefined || aiChosen === null) {
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

  // Book-acquisition comes first: the whole Welcome → Discover → Plan-setup flow
  // runs unobstructed (those are non-"today" views). The forced first-run AI
  // choice only gates the Today *home* screen, and only once the reader actually
  // has a book in hand — so it never interrupts mid-import, and the privacy
  // decision lands when it's about to matter (a passage to send), not before
  // there's anything to read. No implicit default either way: the choice stays
  // explicit.
  if (view.kind === "today" && today != null && !aiChosen) {
    return (
      <div className="app tl-root" data-theme={theme}>
        <main id="main-content">
          <Onboarding onDone={() => setAiChosen(true)} />
        </main>
      </div>
    );
  }

  return (
    <div className="app tl-root" data-theme={theme}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header className="tl-titlebar" data-tauri-drag-region>
        <button className="tl-brand" onClick={() => setView({ kind: "today" })} aria-label="Throughline — home">
          Through<b>line</b>
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

      <main id="main-content">
        {view.kind === "today" && (
          today === null ? (
            // No books yet — the welcome card owns book acquisition; no book chrome.
            <Today today={null} onDiscover={openDiscover} onImport={importBook} onStart={startReading} onStartRescue={startRescue} onRefresh={refreshToday} />
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
                  <Today today={today} onDiscover={openDiscover} onImport={importBook} onStart={startReading} onStartRescue={startRescue} onRefresh={refreshToday} />
                ) : (
                  <NotesBrowser book={today.book} />
                )}
              </div>
            </>
          )
        )}
        {view.kind === "reader" && (
          <Reader today={view.today} mode={view.mode} onExit={exitReader} />
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

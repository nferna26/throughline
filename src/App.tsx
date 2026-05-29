import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Today from "./screens/Today";
import Reader from "./screens/Reader";
import Settings from "./screens/Settings";
import BookSwitcher from "./screens/BookSwitcher";
import NotesBrowser from "./screens/NotesBrowser";
import BookSetupSheet from "./screens/BookSetupSheet";
import RGIcon from "./components/RGIcon";
import "./App.css";
import "./rg-theme.css";
import type { TodayCard, ReaderMode, Book, ImportOutcome } from "./types";

type BookTab = "today" | "notes";

type View =
  | { kind: "today" }
  | { kind: "reader"; today: TodayCard; mode: ReaderMode }
  | { kind: "setup"; book: Book }
  | { kind: "settings" };

export default function App() {
  const [today, setToday] = useState<TodayCard | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "today" });
  const [tab, setTab] = useState<BookTab>("today");
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("rg.theme") as "light" | "dark") || "light"
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rg.theme", theme);
  }, [theme]);

  async function refreshToday() {
    const t = await invoke<TodayCard | null>("cmd_today");
    setToday(t ?? null);
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

  if (today === undefined) {
    return (
      <main className="app rg-root" id="main-content">
        <p className="rg-note-meta" style={{ padding: "var(--rg-7)" }}>Loading…</p>
      </main>
    );
  }

  return (
    <div className="app rg-root" data-theme={theme}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header className="rg-titlebar" data-tauri-drag-region>
        <button className="rg-brand" onClick={() => setView({ kind: "today" })} aria-label="ReadingGym — home">
          Reading<b>Gym</b>
        </button>
        <div className="rg-titlebar-spacer" data-tauri-drag-region />
        <button
          className={view.kind === "settings" ? "rg-iconbtn active" : "rg-iconbtn"}
          onClick={() => setView(view.kind === "settings" ? { kind: "today" } : { kind: "settings" })}
          title="Settings"
          aria-label="Settings"
          aria-pressed={view.kind === "settings"}
        >
          <RGIcon name="settings" size={18} />
        </button>
        <button
          className="rg-iconbtn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          <RGIcon name={theme === "dark" ? "sun" : "moon"} size={18} />
        </button>
      </header>

      <main id="main-content">
        {view.kind === "today" && (
          today === null ? (
            // No books yet — the welcome card owns the import action; no book chrome.
            <Today today={null} onImport={importBook} onStart={startReading} onStartRescue={startRescue} onRefresh={refreshToday} />
          ) : (
            <>
              <div className="rg-bookhead">
                <div className="rg-bookhead-inner">
                  <BookSwitcher activeBook={today.book} onSwitch={switchBook} onImport={importBook} />
                  <div className="rg-seg" role="tablist" aria-label="View">
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
                className="rg-body"
                id="book-panel"
                role="tabpanel"
                aria-labelledby={tab === "today" ? "tab-today" : "tab-notes"}
              >
                {tab === "today" ? (
                  <Today today={today} onImport={importBook} onStart={startReading} onStartRescue={startRescue} onRefresh={refreshToday} />
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
        {view.kind === "settings" && <Settings />}
      </main>
    </div>
  );
}

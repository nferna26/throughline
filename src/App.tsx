import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Today from "./screens/Today";
import Reader from "./screens/Reader";
import Settings from "./screens/Settings";
import "./App.css";
import type { TodayCard } from "./types";

type View =
  | { kind: "today" }
  | { kind: "reader"; today: TodayCard }
  | { kind: "settings" };

export default function App() {
  const [today, setToday] = useState<TodayCard | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "today" });
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
    try {
      await invoke("cmd_import_book", { path });
    } catch (e: any) {
      // Backend returns AppError: { kind, message }. Fall back to String(e) for
      // anything else (network errors thrown by tauri-api itself, etc.).
      const msg = e?.message ?? (typeof e === "string" ? e : JSON.stringify(e));
      alert(`Import failed: ${msg}`);
      return;
    }
    await refreshToday();
  }

  function startReading(t: TodayCard) {
    setView({ kind: "reader", today: t });
  }

  function exitReader() {
    setView({ kind: "today" });
    refreshToday();
  }

  if (today === undefined) {
    return (
      <main className="app" id="main-content">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <div className="app" data-theme={theme}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header className="topbar">
        <span className="brand">ReadingGym</span>
        <div className="spacer" />
        <button
          className="ghost"
          onClick={() => setView({ kind: "settings" })}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
        <button
          className="ghost"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? "☼" : "☾"}
        </button>
      </header>

      <main id="main-content">
        {view.kind === "today" && (
          <Today today={today} onImport={importBook} onStart={startReading} onRefresh={refreshToday} />
        )}
        {view.kind === "reader" && (
          <Reader today={view.today} onExit={exitReader} />
        )}
        {view.kind === "settings" && (
          <Settings onClose={() => setView({ kind: "today" })} />
        )}
      </main>
    </div>
  );
}

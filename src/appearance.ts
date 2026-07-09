import { invoke } from "@tauri-apps/api/core";
import type { SettingsDto } from "./types";

/**
 * Appearance preferences (Settings › Appearance) — one owner for how each
 * applies to the DOM, so the boot path, the Settings pane, and the ⌘⇧L / ⌘+ /
 * ⌘− shortcuts can never disagree.
 *
 * Source of truth is the backend settings table (`cmd_set_appearance`,
 * surfaced on `SettingsDto`). localStorage keeps two mirrors:
 *   - `tl.themePref` — a boot cache so the first frame paints the right theme
 *     before the async settings read resolves (no flash).
 *   - `tl.fontSize` — the long-standing reader text-size key; deliberately
 *     stays frontend-only (it always was), now shared by the reader toolbar,
 *     the Appearance stepper, and ⌘+/⌘−.
 * The pre-redesign `tl.theme` key ("light"|"dark") is migrated once: when the
 * backend has never stored a theme, an existing install keeps exactly the
 * theme it had, and only a genuinely fresh install lands on "auto".
 */

export type ThemePref = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";
export type Typeface = "newsreader" | "iowan" | "charter";
export type LineSpacing = "comfortable" | "compact" | "open";

export const THEME_PREF_KEY = "tl.themePref";
export const LEGACY_THEME_KEY = "tl.theme";
/** Dispatched on window whenever the theme preference changes, from anywhere. */
export const THEME_PREF_EVENT = "tl-theme-pref-changed";

export const TYPEFACES: Typeface[] = ["newsreader", "iowan", "charter"];
export const LINE_SPACINGS: LineSpacing[] = ["comfortable", "compact", "open"];

export function normalizeThemePref(v: unknown): ThemePref | null {
  return v === "light" || v === "dark" || v === "auto" ? v : null;
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "auto") return systemDark ? "dark" : "light";
  return pref;
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** The theme preference for the FIRST paint: mirror cache, else the legacy
 *  pre-redesign key, else Auto. Never touches the backend. */
export function getCachedThemePref(): ThemePref {
  return (
    normalizeThemePref(localStorage.getItem(THEME_PREF_KEY)) ??
    normalizeThemePref(localStorage.getItem(LEGACY_THEME_KEY)) ??
    "auto"
  );
}

/** Persist a theme choice everywhere it lives: the mirror cache, the backend
 *  settings table, and a window event so App re-resolves immediately. */
export function setThemePref(pref: ThemePref): void {
  localStorage.setItem(THEME_PREF_KEY, pref);
  window.dispatchEvent(new CustomEvent<ThemePref>(THEME_PREF_EVENT, { detail: pref }));
  invoke("cmd_set_appearance", { theme: pref }).catch(() => {
    /* the mirror keeps the choice for this session; the next save retries */
  });
}

/** ⌘⇧L: flip the RESOLVED theme. From Auto this lands on the opposite of what
 *  is currently showing (an explicit choice) — predictable, never a no-op. */
export function toggleResolvedTheme(): void {
  const cur = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  setThemePref(cur === "dark" ? "light" : "dark");
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function applyTypeface(t: Typeface): void {
  document.documentElement.dataset.typeface = t;
}

export function applyLineSpacing(s: LineSpacing): void {
  document.documentElement.dataset.linespacing = s;
}

export function normalizeTypeface(v: unknown): Typeface {
  return TYPEFACES.includes(v as Typeface) ? (v as Typeface) : "newsreader";
}

export function normalizeLineSpacing(v: unknown): LineSpacing {
  return LINE_SPACINGS.includes(v as LineSpacing) ? (v as LineSpacing) : "comfortable";
}

/**
 * Boot reconciliation, called once by App: adopt the backend's stored theme
 * (source of truth) or, when it has never been chosen there, seed it from the
 * cached/legacy value — the one-time migration. Also applies the reading
 * typeface + line spacing. Returns the theme preference App should use.
 */
export async function loadAppearance(): Promise<ThemePref> {
  let dto: SettingsDto | null = null;
  try {
    dto = await invoke<SettingsDto>("cmd_get_settings");
  } catch {
    /* outside Tauri (tests/harness) the cached pref is all there is */
  }
  const cached = getCachedThemePref();
  let pref = cached;
  if (dto) {
    const stored = normalizeThemePref(dto.ui_theme);
    if (stored) {
      pref = stored;
      localStorage.setItem(THEME_PREF_KEY, stored);
    } else {
      // Never chosen on the backend: seed it with what this install already
      // shows, so the choice survives relaunches and webview storage resets.
      invoke("cmd_set_appearance", { theme: cached }).catch(() => {});
    }
    applyTypeface(normalizeTypeface(dto.reading_typeface));
    applyLineSpacing(normalizeLineSpacing(dto.reading_line_spacing));
  }
  return pref;
}

/* ── Reading text size (pt) — the long-standing tl.fontSize key ── */

export const FONT_SIZE_KEY = "tl.fontSize";
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 28;
export const FONT_SIZE_DEFAULT = 18;
/** Dispatched on window whenever the text size changes (detail: number). */
export const FONT_SIZE_EVENT = "tl-fontsize-changed";

export function clampFontSize(n: number): number {
  if (Number.isNaN(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

export function readFontSize(): number {
  return clampFontSize(
    parseInt(localStorage.getItem(FONT_SIZE_KEY) ?? String(FONT_SIZE_DEFAULT), 10),
  );
}

/** Nudge the reading text size (⌘+/⌘− and the Appearance stepper). Persists,
 *  clamps, and announces — an open reader updates live. Returns the new size. */
export function adjustFontSize(delta: number): number {
  const next = clampFontSize(readFontSize() + delta);
  localStorage.setItem(FONT_SIZE_KEY, String(next));
  window.dispatchEvent(new CustomEvent<number>(FONT_SIZE_EVENT, { detail: next }));
  return next;
}

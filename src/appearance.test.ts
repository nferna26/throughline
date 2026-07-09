import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  adjustFontSize,
  applyLineSpacing,
  applyTypeface,
  clampFontSize,
  getCachedThemePref,
  loadAppearance,
  normalizeLineSpacing,
  normalizeThemePref,
  normalizeTypeface,
  readFontSize,
  resolveTheme,
  setThemePref,
  toggleResolvedTheme,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_EVENT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LEGACY_THEME_KEY,
  THEME_PREF_EVENT,
  THEME_PREF_KEY,
} from "./appearance";

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-typeface");
  document.documentElement.removeAttribute("data-linespacing");
});

describe("theme resolution", () => {
  it("light/dark are literal; auto follows the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });

  it("normalizers accept only the closed lists", () => {
    expect(normalizeThemePref("auto")).toBe("auto");
    expect(normalizeThemePref("sepia")).toBeNull();
    expect(normalizeThemePref("")).toBeNull();
    expect(normalizeTypeface("charter")).toBe("charter");
    expect(normalizeTypeface("papyrus")).toBe("newsreader");
    expect(normalizeLineSpacing("open")).toBe("open");
    expect(normalizeLineSpacing("double")).toBe("comfortable");
  });
});

describe("cached pref + legacy migration", () => {
  it("prefers the mirror, then the legacy tl.theme, then auto", () => {
    expect(getCachedThemePref()).toBe("auto"); // fresh install
    localStorage.setItem(LEGACY_THEME_KEY, "dark"); // pre-redesign install
    expect(getCachedThemePref()).toBe("dark");
    localStorage.setItem(THEME_PREF_KEY, "light"); // explicit new choice wins
    expect(getCachedThemePref()).toBe("light");
  });

  it("setThemePref persists the mirror, announces, and writes through to the backend", () => {
    const seen: unknown[] = [];
    const onPref = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(THEME_PREF_EVENT, onPref);
    setThemePref("dark");
    window.removeEventListener(THEME_PREF_EVENT, onPref);
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe("dark");
    expect(seen).toEqual(["dark"]);
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_set_appearance", { theme: "dark" });
  });

  it("toggleResolvedTheme flips what is currently showing into an explicit choice", () => {
    document.documentElement.dataset.theme = "dark";
    toggleResolvedTheme();
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe("light");
    document.documentElement.dataset.theme = "light";
    toggleResolvedTheme();
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe("dark");
  });

  it("loadAppearance adopts the backend's stored theme and applies typeface + spacing", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === "cmd_get_settings"
        ? Promise.resolve({ ui_theme: "dark", reading_typeface: "iowan", reading_line_spacing: "open" })
        : Promise.resolve(undefined),
    );
    const pref = await loadAppearance();
    expect(pref).toBe("dark");
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe("dark");
    expect(document.documentElement.dataset.typeface).toBe("iowan");
    expect(document.documentElement.dataset.linespacing).toBe("open");
  });

  it("loadAppearance seeds the backend once when it has never stored a theme (legacy migration)", async () => {
    localStorage.setItem(LEGACY_THEME_KEY, "dark"); // what this install already shows
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === "cmd_get_settings"
        ? Promise.resolve({ ui_theme: "", reading_typeface: "newsreader", reading_line_spacing: "comfortable" })
        : Promise.resolve(undefined),
    );
    const pref = await loadAppearance();
    expect(pref).toBe("dark");
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_set_appearance", { theme: "dark" });
  });
});

describe("DOM application", () => {
  it("stamps data attributes only the reading view consumes", () => {
    applyTypeface("charter");
    applyLineSpacing("compact");
    expect(document.documentElement.dataset.typeface).toBe("charter");
    expect(document.documentElement.dataset.linespacing).toBe("compact");
  });
});

describe("reading text size", () => {
  it("clamps to the humane band and defaults on garbage", () => {
    expect(clampFontSize(5)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(99)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(NaN)).toBe(FONT_SIZE_DEFAULT);
    localStorage.setItem("tl.fontSize", "not-a-number");
    expect(readFontSize()).toBe(FONT_SIZE_DEFAULT);
  });

  it("adjustFontSize persists, clamps, and announces so an open reader updates live", () => {
    const seen: number[] = [];
    const onSize = (e: Event) => seen.push((e as CustomEvent).detail as number);
    window.addEventListener(FONT_SIZE_EVENT, onSize);
    expect(adjustFontSize(+1)).toBe(19);
    expect(localStorage.getItem("tl.fontSize")).toBe("19");
    localStorage.setItem("tl.fontSize", String(FONT_SIZE_MAX));
    expect(adjustFontSize(+1)).toBe(FONT_SIZE_MAX); // clamped at the ceiling
    window.removeEventListener(FONT_SIZE_EVENT, onSize);
    expect(seen).toEqual([19, FONT_SIZE_MAX]);
  });
});

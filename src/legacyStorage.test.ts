import { describe, it, expect, beforeEach } from "vitest";
import { migrateLegacyLocalStorageKeys } from "./legacyStorage";
import { isTutorEnabled } from "./tutorConsent";

beforeEach(() => localStorage.clear());

// CORE-1031: the pre-rename build persisted UI preferences under the legacy
// `rg`-prefixed keys. The shim copies each one to its `tl` twin once, then
// removes the old key — an existing reader's tutor consent and reader prefs
// must survive the rename, never silently reset.
describe("migrateLegacyLocalStorageKeys", () => {
  const LEGACY = "rg";

  it("copies every legacy key to its tl.* twin and removes the original", () => {
    localStorage.setItem(`${LEGACY}.tutorEnabled`, "true");
    localStorage.setItem(`${LEGACY}.fontSize`, "21");
    localStorage.setItem(`${LEGACY}.lineWidth`, "720");
    localStorage.setItem(`${LEGACY}.panelOpen`, "true");
    localStorage.setItem(`${LEGACY}.panelWidth`, "360");

    migrateLegacyLocalStorageKeys();

    expect(localStorage.getItem("tl.tutorEnabled")).toBe("true");
    expect(localStorage.getItem("tl.fontSize")).toBe("21");
    expect(localStorage.getItem("tl.lineWidth")).toBe("720");
    expect(localStorage.getItem("tl.panelOpen")).toBe("true");
    expect(localStorage.getItem("tl.panelWidth")).toBe("360");
    for (const k of ["tutorEnabled", "fontSize", "lineWidth", "panelOpen", "panelWidth"]) {
      expect(localStorage.getItem(`${LEGACY}.${k}`)).toBeNull();
    }
  });

  it("consent state survives for an existing reader (the gate stays open)", () => {
    localStorage.setItem(`${LEGACY}.tutorEnabled`, "true");
    migrateLegacyLocalStorageKeys();
    expect(isTutorEnabled()).toBe(true);
  });

  it("runs once — a second run never clobbers a value written since", () => {
    localStorage.setItem(`${LEGACY}.fontSize`, "21");
    migrateLegacyLocalStorageKeys();
    localStorage.setItem("tl.fontSize", "16"); // the reader changed it post-migration
    migrateLegacyLocalStorageKeys();
    expect(localStorage.getItem("tl.fontSize")).toBe("16");
  });

  it("prefers an existing tl.* value over a stale legacy one", () => {
    localStorage.setItem("tl.panelWidth", "400");
    localStorage.setItem(`${LEGACY}.panelWidth`, "320");
    migrateLegacyLocalStorageKeys();
    expect(localStorage.getItem("tl.panelWidth")).toBe("400");
    expect(localStorage.getItem(`${LEGACY}.panelWidth`)).toBeNull();
  });

  it("is a no-op on a fresh install (no legacy keys)", () => {
    migrateLegacyLocalStorageKeys();
    expect(localStorage.length).toBe(0);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { isTutorEnabled, setTutorEnabled } from "./tutorConsent";

beforeEach(() => localStorage.clear());

describe("tutorConsent", () => {
  it("defaults to disabled (AI is opt-in)", () => {
    expect(isTutorEnabled()).toBe(false);
  });

  it("enabling persists under tl.tutorEnabled", () => {
    setTutorEnabled(true);
    expect(isTutorEnabled()).toBe(true);
    expect(localStorage.getItem("tl.tutorEnabled")).toBe("true");
  });

  it("is revocable — turning it off re-arms the consent gate", () => {
    setTutorEnabled(true);
    setTutorEnabled(false);
    expect(isTutorEnabled()).toBe(false);
  });

  it("treats any non-\"true\" value as disabled", () => {
    localStorage.setItem("tl.tutorEnabled", "yes");
    expect(isTutorEnabled()).toBe(false);
  });
});

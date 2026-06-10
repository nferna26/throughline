import { parseLocator } from "./types";

/**
 * Reader-facing position hint for a stored locator — never the raw string.
 * Percent locators read "32% in"; EPUB CFIs get a plain name; char offsets
 * become a percent when the enclosing section's span is known, and otherwise
 * add nothing beyond the chapter header (null). Shared by the chapter notebook
 * and the New-note modal so "char:"/"cfi:" plumbing never reaches the reader.
 */
export function locatorHint(
  locator: string | null | undefined,
  section?: { start: number; length: number },
): string | null {
  const loc = parseLocator(locator);
  if (loc.kind === "percent") return `${loc.value}% in`;
  if (loc.kind === "cfi") return "EPUB locator";
  if (loc.kind === "char" && section && section.length > 0) {
    const abs = parseInt(loc.value, 10);
    if (Number.isFinite(abs)) {
      const pct = Math.round(((abs - section.start) / section.length) * 100);
      return `${Math.min(100, Math.max(0, pct))}% in`;
    }
  }
  return null;
}

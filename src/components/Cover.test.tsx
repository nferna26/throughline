import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Cover, { clothIndex } from "./Cover";

describe("Cover — the generated cloth book", () => {
  it("paints the title and author on the cloth", () => {
    const { container } = render(<Cover title="Meditations" author="Marcus Aurelius" />);
    const cover = container.querySelector(".tl-cover")!;
    expect(cover.textContent).toContain("Meditations");
    expect(cover.textContent).toContain("Marcus Aurelius");
  });

  it("is deterministic: the same book wears the same cloth everywhere (1..6)", () => {
    const a = clothIndex("Dracula", "Bram Stoker");
    expect(a).toBe(clothIndex("Dracula", "Bram Stoker"));
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(6);
    const { container } = render(<Cover title="Dracula" author="Bram Stoker" />);
    expect(container.querySelector(".tl-cover")!.classList.contains(`c${a}`)).toBe(true);
  });

  it("renders at the requested size and is decorative (its wrapper names it)", () => {
    const { container } = render(<Cover title="Walden" author="Henry D. Thoreau" size="full" />);
    const cover = container.querySelector(".tl-cover")!;
    expect(cover.classList.contains("sz-full")).toBe(true);
    // aria-hidden so the cloth title/author are never announced twice.
    expect(cover).toHaveAttribute("aria-hidden", "true");
  });

  it("omits the author line when there is none", () => {
    const { container } = render(<Cover title="Untitled" />);
    expect(container.querySelector(".tl-cover-ca")).toBeNull();
  });

  it("spreads its cloth across the small warm palette (not all one colour)", () => {
    const titles = [
      "Meditations", "Walden", "Pride and Prejudice", "Frankenstein", "Dracula",
      "The Trial", "A Christmas Carol", "The Time Machine", "Heart of Darkness", "Ethan Frome",
    ];
    const seen = new Set(titles.map((t) => clothIndex(t, "Author")));
    expect(seen.size).toBeGreaterThan(1);
  });
});

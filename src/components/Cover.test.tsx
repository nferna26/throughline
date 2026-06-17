import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Cover, { clothIndex, decollideCovers } from "./Cover";

// c3 (#69474c) and c5 (#5b4a6b) read as the same muted purple, so they share a
// visual class — covers shown together must never pair them.
const cls = (slot: number) => (slot === 5 ? 3 : slot);

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

  it("shows a real embedded cover as-is (no cloth, no gilt frame)", () => {
    const src = "data:image/png;base64,AAAA";
    const { container } = render(<Cover title="Sapiens" author="Harari" coverSrc={src} />);
    const cover = container.querySelector(".tl-cover")!;
    expect(cover.classList.contains("embed")).toBe(true);
    // The cloth treatment (palette class + gilt frame + painted title) is gone.
    expect(cover.className).not.toMatch(/\bc[1-6]\b/);
    expect(container.querySelector(".tl-cover-frame")).toBeNull();
    expect(container.querySelector(".tl-cover-ct")).toBeNull();
    const img = container.querySelector("img.tl-cover-img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(src);
  });

  it("marks a finished book with a completion check (not colour alone)", () => {
    const { container } = render(<Cover title="Walden" author="Thoreau" finished />);
    const done = container.querySelector(".tl-cover-done");
    expect(done).not.toBeNull();
    // The check is a glyph (svg path), so it survives a monochrome / high-contrast view.
    expect(done!.querySelector("svg path")).not.toBeNull();
  });

  it("draws no completion check for an unfinished book", () => {
    const { container } = render(<Cover title="Walden" author="Thoreau" />);
    expect(container.querySelector(".tl-cover-done")).toBeNull();
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

describe("decollideCovers — covers shown together stay distinct", () => {
  it("makes the front-door trio three visually distinct cloths (never two purples)", () => {
    const trio = [
      { title: "Meditations", author: "Marcus Aurelius" },
      { title: "Walden", author: "Henry D. Thoreau" },
      { title: "Pride & Prejudice", author: "Jane Austen" },
    ];
    const colours = decollideCovers(trio);
    expect(new Set(colours.map(cls)).size).toBe(3); // three distinct visual classes
    // c3 and c5 read alike, so at most one of them may appear in the trio.
    expect(colours.filter((c) => c === 3 || c === 5).length).toBeLessThanOrEqual(1);
  });

  it("makes any small group (up to the five visual classes) fully distinct", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ title: `Quintet ${i}`, author: `Auth ${i}` }));
    expect(new Set(decollideCovers(five).map(cls)).size).toBe(5);
  });

  it("a windowed group never pairs adjacent covers (incl. c3/c5) — for the search grid", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Result ${i}`, author: "" }));
    const colours = decollideCovers(many, 2);
    for (let i = 1; i < colours.length; i++) {
      expect(cls(colours[i]), `adjacent ${i - 1}/${i}`).not.toBe(cls(colours[i - 1]));
    }
  });

  it("keeps a lone cover's deterministic base colour and is itself deterministic", () => {
    expect(decollideCovers([{ title: "Solo", author: "One" }])[0]).toBe(clothIndex("Solo", "One"));
    const group = [{ title: "Dracula", author: "Bram Stoker" }, { title: "X", author: "Y" }];
    expect(decollideCovers(group)).toEqual(decollideCovers(group));
  });
});

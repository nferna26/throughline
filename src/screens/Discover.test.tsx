import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import Discover from "./Discover";
import type { DiscoverBook, DiscoverPage, ImportOutcome } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const noop = () => {};

// The library is cover-forward now. Two cell types: curated doorways carry an
// authored blurb (resolved through cmd_discover_books_by_ids over the whole
// catalogue); search / all-books shows cover + title + author only. Choosing a
// book is "Start reading" (the whole cell is the button), and a created book
// hands straight forward to the chosen → pace step (no "Saved" interstitial).

function book(id: number, title: string, author = "Someone"): DiscoverBook {
  return {
    id,
    title,
    author,
    language: "en",
    download_count: 1000 + id,
    has_txt: true,
    has_epub: true,
    txt_url: `pg${id}.txt`,
    epub_url: `pg${id}.epub`,
  };
}

const CATALOGUE_SIZE = 77386;
const mounted: DiscoverPage = { count: CATALOGUE_SIZE, results: [], next_page: null, offline: false };

function wire(opts: {
  search: (query: string | null, page: number) => DiscoverPage;
  booksByIds?: (ids: number[]) => DiscoverBook[];
  onImport?: () => ImportOutcome;
}) {
  vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "cmd_discover_search":
        return Promise.resolve(opts.search((a.query ?? null) as string | null, (a.page ?? 1) as number));
      case "cmd_discover_books_by_ids":
        return Promise.resolve(opts.booksByIds ? opts.booksByIds((a.ids ?? []) as number[]) : []);
      case "cmd_import_from_gutendex":
        return Promise.resolve(
          opts.onImport
            ? opts.onImport()
            : ({ book: { id: "b1" }, created: true } as unknown as ImportOutcome),
        );
      default:
        return Promise.resolve(undefined);
    }
  });
}

async function searchFor(q: string) {
  render(<Discover onBack={noop} onPicked={noop} />);
  fireEvent.change(screen.getByLabelText(/Search the library by title or author/i), { target: { value: q } });
}

beforeEach(() => vi.mocked(invoke).mockReset());

describe("The library — curated doorways", () => {
  it("idle: renders the four doorway shelves, each cell a 'Start reading' button with an authored blurb", async () => {
    wire({
      search: () => mounted,
      // Resolve every requested doorway id to a catalogue row (URLs); the cell's
      // displayed title/author/blurb come from the authored doorway data.
      booksByIds: (ids) => ids.map((id) => book(id, `Catalogue title ${id}`, `Catalogue author ${id}`)),
    });
    render(<Discover onBack={noop} onPicked={noop} />);

    // The labeled shelves are the navigation (no filter pills).
    expect(await screen.findByText("Short classics")).toBeInTheDocument();
    expect(screen.getByText("Familiar names")).toBeInTheDocument();
    expect(screen.getByText("A little philosophy")).toBeInTheDocument();
    expect(screen.getByText("Finish in a weekend")).toBeInTheDocument();

    // A curated cell shows the AUTHORED title/author/blurb (not the raw catalogue
    // row), and the whole cell is a "Start reading" button.
    expect(
      screen.getByText("A man wakes as an insect, and his family adjusts with alarming speed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start reading The Metamorphosis by Franz Kafka/i }),
    ).toBeInTheDocument();
    // Never "Get", never a download glyph word.
    expect(screen.queryByRole("button", { name: /^Get / })).toBeNull();
  });

  it("shows the live catalogue scale in the header, from the mounted empty search", async () => {
    wire({ search: () => mounted, booksByIds: () => [] });
    render(<Discover onBack={noop} onPicked={noop} />);
    expect(await screen.findByText("77,386 free books")).toBeInTheDocument();
    // Never the 200-book seed number.
    expect(screen.queryByText(/\b200\b/)).toBeNull();
  });
});

describe("The library — search (full on-device catalogue)", () => {
  it("search cells show cover + title + author only — never a curated blurb", async () => {
    wire({
      search: (query) =>
        query == null
          ? mounted
          : { count: 1, results: [book(1342, "Pride and Prejudice", "Jane Austen")], next_page: null, offline: false },
    });
    await searchFor("austen");

    // The whole cell is the "Start reading" button (title + author appear in both
    // the cover and the caption below it).
    await screen.findByRole("button", { name: /Start reading Pride and Prejudice by Jane Austen/i });
    expect(screen.getAllByText("Pride and Prejudice").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Jane Austen").length).toBeGreaterThan(0);
    // The index has no blurbs — none must be invented or leak from a curated cell.
    expect(screen.queryByText(/adjusts with alarming speed|sentence by sentence/i)).toBeNull();
    // The meta names the honest sort, not a fabricated count.
    expect(screen.getByText("Sorted by how often they're read")).toBeInTheDocument();
  });

  it("a zero-result search states truthful absence, never an offline excuse", async () => {
    wire({
      search: (query) =>
        query == null ? mounted : { count: 0, results: [], next_page: null, offline: false },
    });
    await searchFor("zzz-not-a-real-book");

    await waitFor(() => expect(screen.getByText(/No match in the library/i)).toBeInTheDocument());
    expect(screen.getByText(/try another title or author/i)).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).toBeNull();
  });

  it("Start reading imports a created book and hands the outcome forward — no interstitial", async () => {
    const outcome = { book: { id: "b1", title: "Pride and Prejudice" }, created: true } as unknown as ImportOutcome;
    const onPicked = vi.fn();
    wire({
      search: (query) =>
        query == null
          ? mounted
          : { count: 1, results: [book(1342, "Pride and Prejudice", "Jane Austen")], next_page: null, offline: false },
      onImport: () => outcome,
    });
    render(<Discover onBack={noop} onPicked={onPicked} />);
    fireEvent.change(screen.getByLabelText(/Search the library by title or author/i), { target: { value: "austen" } });
    const btn = await screen.findByRole("button", { name: /Start reading Pride and Prejudice/i });

    fireEvent.click(btn);

    // The book-chosen → pace step owns the confirmation now; no "Saved" screen here.
    await waitFor(() => expect(onPicked).toHaveBeenCalledWith(outcome));
    expect(screen.queryByText(/Saved to your library/i)).toBeNull();
    const importCalls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_import_from_gutendex");
    expect(importCalls.length).toBe(1);
    expect(importCalls[0][1]).toMatchObject({ book: { txt_url: "pg1342.txt", epub_url: "pg1342.epub" } });
  });

  it("a failed open says what happened, and the cell stays clickable to retry (FT-30)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const query = (a.query ?? null) as string | null;
      switch (cmd) {
        case "cmd_discover_search":
          return Promise.resolve(
            query == null
              ? mounted
              : { count: 1, results: [book(1342, "Pride and Prejudice", "Jane Austen")], next_page: null, offline: false },
          );
        case "cmd_import_from_gutendex":
          return Promise.reject({ message: "The download didn't finish." });
        default:
          return Promise.resolve(undefined);
      }
    });
    render(<Discover onBack={noop} onPicked={noop} />);
    fireEvent.change(screen.getByLabelText(/Search the library by title or author/i), { target: { value: "austen" } });
    const btn = await screen.findByRole("button", { name: /Start reading Pride and Prejudice/i });

    fireEvent.click(btn);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn.t open/i);
    // The cell is clickable again — no dead "Retry"-only flip.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Start reading Pride and Prejudice/i })).toBeEnabled(),
    );
  });
});

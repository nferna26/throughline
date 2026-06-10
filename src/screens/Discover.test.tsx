import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import Discover from "./Discover";
import type { DiscoverBook, DiscoverPage, ImportOutcome } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const noop = () => {};

// Search now runs entirely on-device against the FULL bundled catalogue:
// cmd_discover_search is synchronous, network-free, and can never fail to reach
// the library, so `offline` is always false and a zero-result is truthful
// absence. The shelves come from the bundled seed (cmd_discover_seed).

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

// Wire the two commands the screen calls. `search` answers cmd_discover_search
// (mounted empty query + every typed query); `seed` answers cmd_discover_seed
// (the idle shelves). By default the empty/mounted search reports the whole-
// catalogue scale and the seed is empty (no shelves needed for these tests).
function wire(opts: {
  search: (query: string | null, page: number) => DiscoverPage;
  seed?: (query: string | null, page: number) => DiscoverPage;
  onImport?: () => ImportOutcome;
}) {
  const emptyPage: DiscoverPage = { count: 0, results: [], next_page: null, offline: false };
  vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const query = (a.query ?? null) as string | null;
    const page = (a.page ?? 1) as number;
    switch (cmd) {
      case "cmd_discover_search":
        return Promise.resolve(opts.search(query, page));
      case "cmd_discover_seed":
        return Promise.resolve(opts.seed ? opts.seed(query, page) : emptyPage);
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

// The whole-catalogue size the mounted empty search reports (FT-37).
const CATALOGUE_SIZE = 77386;

async function searchFor(q: string) {
  render(<Discover onBack={noop} onPicked={noop} />);
  fireEvent.change(screen.getByLabelText(/Search all titles and authors/i), { target: { value: q } });
}

beforeEach(() => vi.mocked(invoke).mockReset());

describe("Discover — full on-device catalogue search", () => {
  it("a zero-result search states truthful absence, never an offline excuse", async () => {
    wire({
      search: (query) =>
        query == null
          ? { count: CATALOGUE_SIZE, results: [], next_page: null, offline: false }
          : { count: 0, results: [], next_page: null, offline: false },
    });
    await searchFor("zzz-not-a-real-book");

    // Wait out the 300ms debounce until the no-match state lands.
    await waitFor(() =>
      expect(screen.getByText(/No match in the public-domain library/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/try another title or author/i)).toBeInTheDocument();

    // The whole library was searched — never claim offline or that we couldn't
    // search the full library, and never hedge about a starter shelf.
    expect(screen.queryByText(/offline/i)).toBeNull();
    expect(screen.queryByText(/couldn.t search the full library/i)).toBeNull();
    expect(screen.queryByText(/built-in shelf/i)).toBeNull();
    expect(screen.queryByText(/only searched/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again/i })).toBeNull();
  });

  it("shows the live catalogue scale from the mounted empty search (FT-37)", async () => {
    wire({
      search: (query) =>
        query == null
          ? { count: CATALOGUE_SIZE, results: [], next_page: null, offline: false }
          : { count: 0, results: [], next_page: null, offline: false },
      // Even if the seed had a different size, the scale must come from search.
      seed: () => ({ count: 200, results: [], next_page: null, offline: false }),
    });
    render(<Discover onBack={noop} onPicked={noop} />);

    // The search affordance surfaces the whole-catalogue count (77,386), read
    // from the mounted empty search — formatted with thousands separators and
    // never the 200-book seed number.
    const input = await screen.findByLabelText(/Search all titles and authors/i);
    await waitFor(() =>
      expect(input).toHaveAttribute("placeholder", "Search all 77,386 titles…"),
    );
    expect(input).not.toHaveAttribute("placeholder", expect.stringContaining("200"));
  });

  it("renders real results for a matching query", async () => {
    wire({
      search: (query) =>
        query == null
          ? { count: CATALOGUE_SIZE, results: [], next_page: null, offline: false }
          : {
              count: 2,
              results: [book(1342, "Pride and Prejudice", "Jane Austen"), book(11, "Alice in Wonderland", "Lewis Carroll")],
              next_page: null,
              offline: false,
            },
    });
    await searchFor("austen");

    await waitFor(() => expect(screen.getByText(/Pride and Prejudice/i)).toBeInTheDocument());
    expect(screen.getByText(/Jane Austen/i)).toBeInTheDocument();
    // The count line reflects the full-catalogue match total ("2 results for …").
    expect(screen.getByText(/results for/i).textContent).toMatch(/2\s*results for/i);
  });

  it("a failed Get says what happened and what to do, and offers Retry (FT-30)", async () => {
    // The import rejects (e.g. the download didn't finish). The screen must
    // surface a spoken-aloud error line, not just flip the button to Retry.
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const query = (a.query ?? null) as string | null;
      switch (cmd) {
        case "cmd_discover_search":
        case "cmd_discover_seed":
          return query == null
            ? Promise.resolve({ count: 1, results: [book(1342, "Pride and Prejudice", "Jane Austen")], next_page: null, offline: false })
            : Promise.resolve({ count: 1, results: [book(1342, "Pride and Prejudice", "Jane Austen")], next_page: null, offline: false });
        case "cmd_import_from_gutendex":
          return Promise.reject({ message: "The download didn't finish." });
        default:
          return Promise.resolve(undefined);
      }
    });
    render(<Discover onBack={noop} onPicked={noop} />);

    fireEvent.change(screen.getByLabelText(/Search all titles and authors/i), { target: { value: "austen" } });
    await waitFor(() => expect(screen.getByText(/Pride and Prejudice/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Get Pride and Prejudice/i }));

    // The failure is announced (role=alert) in the app's voice…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn.t .*(download|get)/i);
    // …and the row offers a Retry.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Get Pride and Prejudice/i }).textContent).toMatch(/Retry/i),
    );
  });

  it("Get imports a result and pauses on the saved confirmation", async () => {
    const outcome = { book: { id: "b1", title: "Pride and Prejudice" }, created: true } as unknown as ImportOutcome;
    wire({
      search: (query) =>
        query == null
          ? { count: CATALOGUE_SIZE, results: [], next_page: null, offline: false }
          : { count: 1, results: [book(1342, "Pride and Prejudice", "Jane Austen")], next_page: null, offline: false },
      onImport: () => outcome,
    });
    await searchFor("austen");

    await waitFor(() => expect(screen.getByText(/Pride and Prejudice/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Get Pride and Prejudice/i }));

    // A newly-created book pauses on the calm "Saved to your library" hand-off.
    await waitFor(() => expect(screen.getByText(/Saved to your library/i)).toBeInTheDocument());
    const importCalls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_import_from_gutendex");
    expect(importCalls.length).toBe(1);
    expect(importCalls[0][1]).toMatchObject({ book: { txt_url: "pg1342.txt", epub_url: "pg1342.epub" } });
  });
});

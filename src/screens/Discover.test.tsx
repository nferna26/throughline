import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import Discover from "./Discover";
import type { DiscoverPage } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const noop = () => {};

// FT-07 (CORE-1040): when the live catalogue is unreachable, every search runs
// against the bundled seed — 200 popular titles out of ~78,000. A zero-hit
// there says nothing about the library, so the empty state must say what was
// actually searched and invite a retry — never assert the book doesn't exist.
function wire(page: DiscoverPage) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_discover_seed":
      case "cmd_discover_search":
        return Promise.resolve(page);
      default:
        return Promise.resolve(undefined);
    }
  });
}

const EMPTY_OFFLINE: DiscoverPage = { count: 0, results: [], next_page: null, offline: true };
const EMPTY_LIVE: DiscoverPage = { count: 0, results: [], next_page: null, offline: false };

async function searchFor(q: string) {
  render(<Discover onBack={noop} onPicked={noop} />);
  fireEvent.change(screen.getByLabelText(/Search all titles and authors/i), { target: { value: q } });
}

beforeEach(() => vi.mocked(invoke).mockReset());

describe("Discover — zero hits while the live catalogue is unreachable", () => {
  it("says it only searched a starter shelf and never asserts absence", async () => {
    wire(EMPTY_OFFLINE);
    await searchFor("middlemarch");

    // Wait out the 300ms debounce until the offline empty state lands.
    await waitFor(() =>
      expect(screen.getByText(/only searched a built-in shelf of popular titles/i)).toBeInTheDocument(),
    );
    // Never claim the book isn't in the public-domain library — we didn't look there.
    expect(screen.queryByText(/isn['’]t in the public-domain library/i)).toBeNull();
    // And a visible way to try the full library again.
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("Try again re-runs the same search against the catalogue", async () => {
    wire(EMPTY_OFFLINE);
    await searchFor("middlemarch");
    await waitFor(() => expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument());

    const before = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_discover_search").length;
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_discover_search");
      expect(calls.length).toBe(before + 1);
      expect(calls[calls.length - 1][1]).toMatchObject({ query: "middlemarch" });
    });
  });

  it("a genuine live zero-hit still says the title isn't in the library", async () => {
    wire(EMPTY_LIVE);
    await searchFor("zzz-not-a-book");

    await waitFor(() =>
      expect(screen.getByText(/isn['’]t in the public-domain library/i)).toBeInTheDocument(),
    );
    // The full library WAS searched — no starter-shelf hedging, no retry nudge.
    expect(screen.queryByText(/only searched a built-in shelf/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again/i })).toBeNull();
  });
});

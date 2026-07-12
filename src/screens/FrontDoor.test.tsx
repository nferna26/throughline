import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import FrontDoor from "./FrontDoor";
import type { DiscoverBook, ImportOutcome } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const noop = () => {};

function book(id: number): DiscoverBook {
  return {
    id, title: `t${id}`, author: `a${id}`, language: "en", download_count: 1,
    has_txt: true, has_epub: true, txt_url: `pg${id}.txt`, epub_url: `pg${id}.epub`,
  };
}

function wire(opts: {
  starters?: () => DiscoverBook[];
  onImport?: () => ImportOutcome;
  activate?: () => Promise<unknown>;
} = {}) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_discover_books_by_ids":
        // Resolve the three starter ids (2680 / 205 / 1342) so the trio is live.
        return Promise.resolve(opts.starters ? opts.starters() : [book(2680), book(205), book(1342)]);
      case "cmd_import_from_gutendex":
        return Promise.resolve(
          opts.onImport ? opts.onImport() : ({ book: { id: "b1" }, created: true } as unknown as ImportOutcome),
        );
      case "cmd_activate_company":
        return opts.activate ? opts.activate() : Promise.resolve({ provider_active: true, has_license: true });
      default:
        return Promise.resolve(undefined);
    }
  });
}

beforeEach(() => vi.mocked(invoke).mockReset());

describe("FrontDoor — the first-run screen", () => {
  it("leads with the serif hero, the three cloth covers, and the two acquisition paths", async () => {
    wire();
    render(<FrontDoor onDiscover={noop} onImport={noop} onPicked={noop} />);

    expect(screen.getByText("Begin with a book you mean to finish.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Browse the library/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import a \.txt or \.epub/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Your books and notes stay on this Mac/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a selected passage, or the section you're starting in Deep Study/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/only after you confirm it/i)).toBeInTheDocument();
    // The categorical no-cloud claim must stay gone: a remote tutor mode
    // exists, so absolute "everything…no cloud" copy would be false (PRIV-001).
    expect(screen.queryByText(/Everything stays on this Mac/i)).toBeNull();
    // The starter covers resolve into real "Start reading" buttons.
    expect(
      await screen.findByRole("button", { name: /Start reading Meditations by Marcus Aurelius/i }),
    ).toBeInTheDocument();
  });

  it("Browse opens the library; Import opens the file picker", () => {
    wire();
    const onDiscover = vi.fn();
    const onImport = vi.fn();
    render(<FrontDoor onDiscover={onDiscover} onImport={onImport} onPicked={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /Browse the library/i }));
    expect(onDiscover).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Import a \.txt or \.epub/i }));
    expect(onImport).toHaveBeenCalled();
  });

  it("clicking a starter cover imports that book and hands the outcome forward", async () => {
    const outcome = { book: { id: "b1", title: "Pride & Prejudice" }, created: true } as unknown as ImportOutcome;
    const onPicked = vi.fn();
    wire({ onImport: () => outcome });
    render(<FrontDoor onDiscover={noop} onImport={noop} onPicked={onPicked} />);

    const cover = await screen.findByRole("button", { name: /Start reading Pride & Prejudice by Jane Austen/i });
    // The cover is inert until its catalogue row resolves (import URLs).
    await waitFor(() => expect(cover).toBeEnabled());
    fireEvent.click(cover);
    await waitFor(() => expect(onPicked).toHaveBeenCalledWith(outcome));
    const importCalls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_import_from_gutendex");
    expect(importCalls.length).toBe(1);
    expect(importCalls[0][1]).toMatchObject({ book: { txt_url: "pg1342.txt", epub_url: "pg1342.epub" } });
  });

  it("activation: resting → entering → success, never a gate", async () => {
    wire();
    render(<FrontDoor onDiscover={noop} onImport={noop} onPicked={noop} />);

    // Resting whisper.
    fireEvent.click(screen.getByRole("button", { name: /Bought Throughline\? Enter your code/i }));
    // Entering: the mono field + Activate.
    const input = screen.getByLabelText("Activation code");
    fireEvent.change(input, { target: { value: "56HA-N460-C47S" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    // Success banner — the same copy the deep link's confirmation uses.
    expect(await screen.findByText("You're activated. Welcome in.")).toBeInTheDocument();
    expect(
      screen.getByText(/The tutor is ready in the margin, whenever a passage gives you pause\./),
    ).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("cmd_activate_company", {
      activationToken: "56HA-N460-C47S",
    });
  });

  it("activation: a bad code is warm clay with a recovery mailto — never red, never a dead end", async () => {
    wire({
      activate: () =>
        Promise.reject({ kind: "Validation", message: "That activation code is invalid, expired, or already used." }),
    });
    render(<FrontDoor onDiscover={noop} onImport={noop} onPicked={noop} />);

    fireEvent.click(screen.getByRole("button", { name: /Enter your code/i }));
    fireEvent.change(screen.getByLabelText("Activation code"), { target: { value: "WRONG-CODE-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(await screen.findByText(/That code didn't activate\. Check for a typo and try again\./)).toBeInTheDocument();
    // The recovery path so a paying buyer is never stranded.
    const mail = screen.getByRole("link", { name: /hello@readthroughline\.com/ });
    expect(mail).toHaveAttribute("href", "mailto:hello@readthroughline.com");
    // Reading is never gated — the covers + Browse + Import all still stand.
    expect(screen.getByRole("button", { name: /Browse the library/i })).toBeInTheDocument();
  });
});

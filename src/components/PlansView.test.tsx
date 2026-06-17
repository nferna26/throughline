import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlansView from "./PlansView";
import type { TodayCard } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const TODAY = {
  book: { id: "b1", title: "Confessions", author: "Augustine" },
  fraction_complete: 0.2,
} as unknown as TodayCard;

beforeEach(() => {
  mockInvoke.mockReset();
  // PlansView loads the book's plans on mount.
  mockInvoke.mockResolvedValue([]);
});

describe("PlansView — Remove from library (CORE-1093)", () => {
  it("offers a Remove-from-library affordance that asks the parent, never deleting inline", async () => {
    const onRemoveBook = vi.fn();
    const user = userEvent.setup();
    render(
      <PlansView
        bookId="b1"
        bookTitle="Confessions"
        bookAuthor="Augustine"
        today={TODAY}
        onClose={() => {}}
        onContinueReading={() => {}}
        onStartNewPlan={() => {}}
        onRemoveBook={onRemoveBook}
      />,
    );
    const remove = await screen.findByRole("button", { name: /Remove from library/i });
    await user.click(remove);
    expect(onRemoveBook).toHaveBeenCalledTimes(1);
    // The view only requests removal — the confirmed delete is the parent's job.
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_delete_book", expect.anything());
  });
});

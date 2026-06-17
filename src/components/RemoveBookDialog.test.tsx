import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RemoveBookDialog from "./RemoveBookDialog";

describe("RemoveBookDialog — two source-specific confirmations", () => {
  it("imported: names the real loss and reassures about the original file", () => {
    render(
      <RemoveBookDialog title="Sapiens" provenance="imported" onKeep={() => {}} onRemove={() => {}} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Remove Sapiens?" })).toBeInTheDocument();
    expect(
      screen.getByText("Your reading progress, notes, and tutor history for it will be deleted."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your original file isn’t affected/)).toBeInTheDocument();
    // Never any "only copy" language.
    expect(dialog.textContent).not.toMatch(/only copy/i);
  });

  it("catalogue: light loss, free to re-add from the catalogue", () => {
    render(
      <RemoveBookDialog title="Meditations" provenance="catalogue" onKeep={() => {}} onRemove={() => {}} />,
    );
    expect(screen.getByRole("heading", { name: "Remove Meditations?" })).toBeInTheDocument();
    expect(
      screen.getByText("It leaves your library. You can add it back from the catalogue anytime, free."),
    ).toBeInTheDocument();
    expect(screen.getByText("Your reading plan and notes for it will be cleared.")).toBeInTheDocument();
  });

  it("offers Keep it / Remove, and opens with focus on Keep it (the safe default)", () => {
    render(
      <RemoveBookDialog title="Walden" provenance="imported" onKeep={() => {}} onRemove={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Keep it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
  });

  it("Remove confirms; Keep it and Escape both keep the book", async () => {
    const onRemove = vi.fn();
    const onKeep = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <RemoveBookDialog title="Walden" provenance="imported" onKeep={onKeep} onRemove={onRemove} />,
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    rerender(
      <RemoveBookDialog title="Walden" provenance="imported" onKeep={onKeep} onRemove={onRemove} />,
    );
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onKeep).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onKeep).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the opener when it closes", () => {
    function Harness() {
      return (
        <>
          <button>opener</button>
          <RemoveBookDialog title="Walden" provenance="catalogue" onKeep={() => {}} onRemove={() => {}} />
        </>
      );
    }
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Harness />);
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

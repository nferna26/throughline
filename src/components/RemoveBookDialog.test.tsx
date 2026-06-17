import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RemoveBookDialog from "./RemoveBookDialog";

describe("RemoveBookDialog", () => {
  it("names the book and warns what is deleted, with Remove / Cancel actions", () => {
    render(<RemoveBookDialog bookTitle="Confessions" onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: /Remove .*Confessions.* from your library\?/ })).toBeInTheDocument();
    expect(screen.getByText(/place and notes for it will be deleted/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("opens with focus on Cancel (the safe choice), not Remove", () => {
    render(<RemoveBookDialog bookTitle="Confessions" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("Remove confirms; Cancel and Escape both cancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <RemoveBookDialog bookTitle="Confessions" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(<RemoveBookDialog bookTitle="Confessions" onConfirm={onConfirm} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the opener when it closes", async () => {
    const onCancel = vi.fn();
    function Harness() {
      return (
        <>
          <button>opener</button>
          <RemoveBookDialog bookTitle="Confessions" onConfirm={() => {}} onCancel={onCancel} />
        </>
      );
    }
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Harness />);
    // Dialog took focus (Cancel).
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    unmount();
    // On close, focus returns to whatever was focused when it opened.
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRef } from "react";
import CloudConsentSheet, { type EnvelopePreview } from "./CloudConsentSheet";

// Component-level pins for the consent sheet itself. The R6-1 send-boundary
// behavior (binding validation, drift, exactly-one-ask) is exercised through
// the real invokers in MarginTutorCard.test.tsx / SectionBriefingCard.test.tsx;
// THIS suite pins the sheet's own contract — above all that it is a REAL
// full-screen modal portaled to <body>, immune to the margin rail's and the
// anchored card's clipping/stacking/inert behavior (the prelaunch blocker).

const ENVELOPE: EnvelopePreview = {
  host: "api.anthropic.com",
  provider: "anthropic",
  fingerprint: "fp:anthropic:42",
  envelope: {
    book_title: "Meditations",
    author: "Marcus Aurelius",
    chapter: "Book II",
    selection_bounded: "Begin the morning by saying to thyself…",
    prompt: "FULL PROMPT, WORD FOR WORD — the hardened wrapper around the reader's selection.",
  },
};

function sheetProps(over: Partial<Parameters<typeof CloudConsentSheet>[0]> = {}) {
  return {
    host: "api.anthropic.com",
    disclosure: "Your selected passage (below) is sent to api.anthropic.com so the tutor can answer.",
    envelope: ENVELOPE as EnvelopePreview | null | undefined,
    onRetryEnvelope: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...over,
  };
}

describe("CloudConsentSheet — portaled full-screen modal (the clipping fix)", () => {
  it("renders the scrim as a DIRECT child of document.body, never inside the invoking card's subtree", () => {
    // Simulate the hostile ancestry the real invokers mount from: the margin
    // rail (overflow: hidden; transformed in the narrow-drawer layout) with
    // the anchored card inside it. If the sheet rendered in place, this
    // subtree would clip the "full-screen" scrim to the drawer's box.
    const props = sheetProps();
    const { container } = render(
      <aside className="tl-margin-rail" style={{ overflow: "hidden", transform: "translateX(0px)" }}>
        <div className="tl-anchored is-active">
          <div className="tl-card tl-tutor">
            <CloudConsentSheet {...props} />
          </div>
        </div>
      </aside>,
    );

    // Not a descendant of the render container (the rail/card subtree)…
    expect(container.querySelector(".tl-scrim")).toBeNull();
    // …but a direct child of <body>, outside every transformed/overflow/inert
    // ancestor, so `position: fixed; inset: 0` really means the viewport.
    const scrim = document.body.querySelector(".tl-scrim") as HTMLElement;
    expect(scrim).not.toBeNull();
    expect(scrim.parentElement).toBe(document.body);
    expect(scrim.closest(".tl-margin-rail")).toBeNull();
    expect(scrim.closest(".tl-card")).toBeNull();
    // The dialog inside it still carries the modal semantics.
    const dialog = screen.getByRole("dialog", { name: /Send this passage to api\.anthropic\.com/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(scrim.contains(dialog)).toBe(true);
  });

  it("synthetic clicks inside the portal still bubble through the REACT tree (card onClick parity)", () => {
    // MarginTutorCard's root has onClick={onActivate}; before the portal, a
    // scrim click bubbled to it in the DOM. React portals preserve SYNTHETIC
    // bubbling through the component tree, so the behavior must not change.
    const onActivate = vi.fn();
    const props = sheetProps();
    render(
      <div className="tl-card tl-tutor" onClick={onActivate}>
        <CloudConsentSheet {...props} />
      </div>,
    );
    fireEvent.click(document.body.querySelector(".tl-scrim") as HTMLElement);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1); // parity with the pre-portal DOM bubbling
    // Clicks on the sheet itself stay stopped (the sheet's stopPropagation).
    onActivate.mockClear();
    fireEvent.click(screen.getByRole("dialog", { name: /Send this passage/i }));
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe("CloudConsentSheet — modal a11y contract survives the portal (PRIV-A11Y-009)", () => {
  it("initial focus lands on 'Not now' (the safe choice)", () => {
    render(<CloudConsentSheet {...sheetProps()} />);
    expect(screen.getByRole("button", { name: "Not now" })).toHaveFocus();
  });

  it("Escape cancels; scrim click cancels; the sheet unmounting restores focus to the prior element", () => {
    const invoker = document.createElement("button");
    invoker.textContent = "invoker";
    document.body.appendChild(invoker);
    invoker.focus();

    const props = sheetProps();
    const { unmount } = render(<CloudConsentSheet {...props} />);
    const dialog = screen.getByRole("dialog", { name: /Send this passage/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(document.body.querySelector(".tl-scrim") as HTMLElement);
    expect(props.onCancel).toHaveBeenCalledTimes(2);
    unmount();
    expect(invoker).toHaveFocus();
    invoker.remove();
  });

  it("prefers the DURABLE returnFocus target on close (Deep Study's transient invoker)", () => {
    function Harness({ open }: { open: boolean }) {
      const cardRef = useRef<HTMLDivElement | null>(null);
      return (
        <div>
          <div ref={cardRef} tabIndex={-1} data-testid="briefing-card" />
          {open && <CloudConsentSheet {...sheetProps({ returnFocus: cardRef, subject: "section" })} />}
        </div>
      );
    }
    const { rerender } = render(<Harness open />);
    expect(screen.getByRole("dialog", { name: /Send this section/i })).toBeInTheDocument();
    rerender(<Harness open={false} />);
    expect(screen.getByTestId("briefing-card")).toHaveFocus();
  });

  it("Tab stays trapped inside the PORTALED sheet — focus never escapes to the body", () => {
    render(<CloudConsentSheet {...sheetProps()} />);
    const dialog = screen.getByRole("dialog", { name: /Send this passage/i });
    // jsdom can't compute visibility (offsetParent), so the honest assertion
    // is the trap PROPERTY: focus never leaves the sheet in either direction —
    // which is exactly what must survive the move to document.body (the trap
    // logic lives on the sheet's own node, not on any ancestor).
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("CloudConsentSheet — exact-envelope disclosure and fail-closed behavior", () => {
  it("with the envelope loaded: exact host, every book-derived field, the FULL bounded text, and the verbatim prompt", () => {
    render(<CloudConsentSheet {...sheetProps()} />);
    expect(screen.getByText(/Send this passage to api\.anthropic\.com\?/)).toBeInTheDocument();
    expect(screen.getByText(/Book: Meditations by Marcus Aurelius · Chapter: Book II/)).toBeInTheDocument();
    expect(screen.getByText(/exactly as it will be sent/)).toBeInTheDocument();
    expect(screen.getByText(/Begin the morning by saying to thyself…/)).toBeInTheDocument();
    expect(screen.getByText(ENVELOPE.envelope.prompt)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send to api\.anthropic\.com/ })).toBeEnabled();
  });

  it("while the envelope loads (undefined): Send stays DISABLED against an unknown payload", () => {
    render(<CloudConsentSheet {...sheetProps({ envelope: undefined })} />);
    expect(screen.getByText(/Preparing the exact text to be sent…/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send to/ })).toBeDisabled();
  });

  it("a FAILED preview (null) fails closed: Send disabled, Try again re-fetches, Not now still works", () => {
    const props = sheetProps({ envelope: null });
    render(<CloudConsentSheet {...props} />);
    expect(
      screen.getByText(/Couldn't prepare the exact text to be sent, so nothing will be sent\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send to/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetryEnvelope).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("a FAILED confirm keeps the sheet OPEN, says nothing was sent, and stays recoverable", async () => {
    const props = sheetProps({
      onConfirm: vi.fn().mockRejectedValueOnce({ message: "the backend refused" }).mockResolvedValueOnce(undefined),
    });
    render(<CloudConsentSheet {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Send to api\.anthropic\.com/ }));
    expect(
      await screen.findByText(/Couldn't record your OK \(the backend refused\), so nothing was sent\./),
    ).toBeInTheDocument();
    // Recoverable, never a dead sheet: Send again works…
    const send = screen.getByRole("button", { name: /Send to api\.anthropic\.com/ });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledTimes(2));
    // …and so does Not now.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("CANCELLATION AUTHORITY: while a confirm is settling, Escape / Not now / the scrim are inert", async () => {
    let settle!: () => void;
    const props = sheetProps({
      onConfirm: vi.fn(() => new Promise<void>((res) => { settle = res; })),
    });
    render(<CloudConsentSheet {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Send to api\.anthropic\.com/ }));
    const dialog = screen.getByRole("dialog", { name: /Send this passage/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(document.body.querySelector(".tl-scrim") as HTMLElement);
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
    expect(props.onCancel).not.toHaveBeenCalled();
    settle();
    await waitFor(() => expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled());
    // Authority returns once the confirm settled.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('the "section" subject (Deep Study) drives the copy end to end', () => {
    render(
      <CloudConsentSheet
        {...sheetProps({
          subject: "section",
          disclosure: "Today's section (below) is sent to api.anthropic.com so Deep Study can prepare the briefing.",
        })}
      />,
    );
    expect(screen.getByRole("dialog", { name: /Send this section to api\.anthropic\.com/i })).toBeInTheDocument();
    expect(screen.getByText(/This is the section, exactly as it will be sent:/)).toBeInTheDocument();
    expect(screen.getByText(/so Deep Study can prepare the briefing/)).toBeInTheDocument();
  });
});

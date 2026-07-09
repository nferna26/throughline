import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import FeedbackPanel from "./FeedbackPanel";

// ── Tauri core mock: invoke by command name ─────────────────────────────────
const mocks = vi.hoisted(() => {
  const invoke = vi.fn(
    (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null),
  );
  return { invoke };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const DIAG = { app_version: "0.8.3", macos_version: "15.5", mode: "included" };

function setImpl(sendResult: "ok" | "fail" = "ok") {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "cmd_feedback_diagnostics") return Promise.resolve(DIAG);
    if (cmd === "cmd_send_feedback")
      return sendResult === "ok" ? Promise.resolve(undefined) : Promise.reject(new Error("offline"));
    return Promise.resolve(null);
  });
}

function sendCalls() {
  return mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_send_feedback");
}

beforeEach(() => {
  cleanup();
  setImpl("ok");
  // The draft persists in localStorage by design; isolate each test.
  localStorage.clear();
  // jsdom is "online" by default; make it explicit for the offline test to flip.
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true, writable: true });
});

const panel = () => <FeedbackPanel mode="included" onClose={() => {}} />;

// ── (11) LITERAL preview ─────────────────────────────────────────────────────
describe("preview shows exactly what will be sent", () => {
  it("renders the Rust-sourced diagnostics and the typed message, and only those", async () => {
    render(panel());
    // The 3 diagnostics come from cmd_feedback_diagnostics (Rust) — the exact sent values.
    expect(await screen.findByTestId("preview-app-version")).toHaveTextContent("0.8.3");
    expect(screen.getByTestId("preview-macos")).toHaveTextContent("15.5");
    expect(screen.getByTestId("preview-mode")).toHaveTextContent("included");

    fireEvent.change(screen.getByLabelText("Your message"), {
      target: { value: "The margin card overlaps at narrow widths." },
    });
    expect(screen.getByTestId("preview-message")).toHaveTextContent(
      "The margin card overlaps at narrow widths.",
    );
    // The honest line is present verbatim, with no em dashes.
    const honest = screen.getByText(/Throughline never sends anything on its own/);
    expect(honest.textContent).toContain("nothing else.");
    expect(honest.textContent).not.toContain("—");
  });
});

// ── (12) success → confirmation + box clears ─────────────────────────────────
describe("send success", () => {
  it("confirms and clears the message on a successful send", async () => {
    render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "great app" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(await screen.findByText(/on its way/i)).toBeInTheDocument();
    expect(sendCalls().length).toBe(1);
    // The textarea is gone in the confirmed state (message cleared, not preserved on success).
    expect(screen.queryByLabelText("Your message")).toBeNull();
  });
});

// ── (13) failure → message PRESERVED + fallback ──────────────────────────────
describe("send failure preserves the message and offers a fallback", () => {
  it("keeps the textarea, shows a calm error, and offers mailto + Copy prefilled", async () => {
    setImpl("fail");
    render(panel());
    await screen.findByTestId("preview-app-version");
    const box = screen.getByLabelText("Your message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "please keep my words" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    // The reader's words survive.
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe(
      "please keep my words",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/your message is safe below/i);
    const mailto = screen.getByRole("link", { name: /email it instead/i }) as HTMLAnchorElement;
    expect(mailto.href.startsWith("mailto:hello@readthroughline.com")).toBe(true);
    expect(decodeURIComponent(mailto.href)).toContain("please keep my words");
    expect(decodeURIComponent(mailto.href)).toContain("0.8.3"); // diagnostics prefilled
    expect(screen.getByRole("button", { name: /copy feedback/i })).toBeInTheDocument();
  });

  it("offline goes straight to the fallback without pretending to send", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true, writable: true });
    render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(sendCalls().length).toBe(0); // never claimed to send
  });
});

// ── (14) honeypot present, hidden, not tab-reachable ─────────────────────────
describe("honeypot", () => {
  it("is present, visually hidden, and out of the tab order", async () => {
    const { container } = render(panel());
    await screen.findByTestId("preview-app-version");
    const hp = container.querySelector('input[name="website"]') as HTMLInputElement;
    expect(hp).toBeTruthy();
    expect(hp.tabIndex).toBe(-1);
    expect(hp.getAttribute("aria-hidden")).toBe("true");
    expect(hp.style.position).toBe("absolute"); // offscreen
  });

  it("a filled honeypot never calls cmd_send_feedback", async () => {
    const { container } = render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "real text" } });
    const hp = container.querySelector('input[name="website"]') as HTMLInputElement;
    fireEvent.change(hp, { target: { value: "https://spam" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(sendCalls().length).toBe(0);
  });
});

// ── Six-state spec (settings redesign): sending, success, failure, draft ────
describe("six states", () => {
  it("success replaces the pane with the serif thank-you and a Close action", async () => {
    render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "lovely" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.getByRole("heading", { name: "Thank you." })).toBeInTheDocument();
    expect(screen.getByText("Your feedback is on its way.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    // The Cancel/Send footer is gone with the fields.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("failure keeps the footer as Cancel + 'Send again' (enabled)", async () => {
    setImpl("fail");
    render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "words" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    const again = screen.getByRole("button", { name: "Send again" });
    expect(again).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("the empty state disables Send and previews '(your message above)' with live diagnostics", async () => {
    render(panel());
    await screen.findByTestId("preview-app-version");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByTestId("preview-message")).toHaveTextContent("(your message above)");
    // The reply-email preview row appears ONLY when an email is given.
    expect(screen.queryByTestId("preview-email")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Reply email/i), { target: { value: "me@x.com" } });
    expect(screen.getByTestId("preview-email")).toHaveTextContent("me@x.com");
  });

  it("the draft (message + email) survives unmount and remount until sent", async () => {
    const first = render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "keep me" } });
    fireEvent.change(screen.getByLabelText(/Reply email/i), { target: { value: "me@x.com" } });
    first.unmount();

    render(panel());
    await screen.findByTestId("preview-app-version");
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("keep me");
    expect((screen.getByLabelText(/Reply email/i) as HTMLInputElement).value).toBe("me@x.com");

    // …and is cleared once the feedback actually sends.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(localStorage.getItem("tl.feedbackDraft")).toBeNull();
    expect(localStorage.getItem("tl.feedbackDraftEmail")).toBeNull();
  });

  it("Escape returns to the previous pane via onClose, preserving the draft", async () => {
    const onClose = vi.fn();
    render(<FeedbackPanel mode="included" onClose={onClose} />);
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "draft" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tl.feedbackDraft")).toBe("draft");
  });
});

// ── (15)+(16) request body: email optional, and only message+email leave the UI ──
describe("the request the panel makes", () => {
  it("omits the email when blank and includes it when filled", async () => {
    render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(sendCalls()[0][1]).toEqual({ message: "hi", email: null });

    cleanup();
    setImpl("ok");
    render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "hi" } });
    fireEvent.change(screen.getByLabelText(/Reply email/i), { target: { value: " me@x.com " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(sendCalls()[0][1]).toEqual({ message: "hi", email: "me@x.com" });
  });

  it("the UI sends ONLY message + email (diagnostics are added in Rust; no reading content path)", async () => {
    render(panel());
    await screen.findByTestId("preview-app-version");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    const args = sendCalls()[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["email", "message"]);
    // Structurally impossible for reading content / book title / license to be here.
    for (const k of ["license", "token", "book", "passage", "locator", "provider_key"]) {
      expect(k in args).toBe(false);
    }
  });
});

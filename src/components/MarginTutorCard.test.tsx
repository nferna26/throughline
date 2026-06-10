import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import MarginTutorCard, { type TutorDraft } from "./MarginTutorCard";

// ── Tauri core mock: invoke (by command name) + a drivable Channel ──────────
// vi.mock's factory is hoisted above the module body, so the mock objects must
// come from vi.hoisted (which runs first).
const mocks = vi.hoisted(() => {
  class MockChannel {
    onmessage: ((e: unknown) => void) | null = null;
  }
  const invoke = vi.fn(
    (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null),
  );
  return { invoke, Channel: MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: mocks.Channel,
}));

type MockChannelT = InstanceType<typeof mocks.Channel>;

function setImpl() {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_get_settings":
        return Promise.resolve({
          export_path: "/x",
          ai_provider: "local",
          ai_base_url: "http://localhost:1234/v1",
          ai_model: "gemma-4-31b-it-mlx",
          ai_requests_retention_days: 90,
        });
      case "cmd_ai_ask":
        // Each call gets a fresh ai_request_id so we can tell brief from deep.
        return Promise.resolve({ ai_request_id: `ai_${cmd}`, prompt_sent: "(hidden)", provider_host: "localhost" });
      case "cmd_test_ai_connection":
        return Promise.resolve({ reachable: true, first_model_id: "gemma-4-31b-it-mlx", message: "ok" });
      case "cmd_set_ai_settings":
        return Promise.resolve({});
      case "cmd_save_ai_response_as_note":
        return Promise.resolve({ id: "note_1", note_type: "TutorNote" });
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  setImpl();
});

function baseDraft(overrides: Partial<TutorDraft> = {}): TutorDraft {
  return {
    draftId: "draft_1",
    mode: "explain",
    locator: "char:120",
    anchorStart: "char:120",
    anchorEnd: "char:168",
    anchoredText: "the unjust man is happy",
    chapter: "Book I",
    ...overrides,
  };
}

function asksOfDepth(depth: string) {
  return mocks.invoke.mock.calls.filter(
    (c) => c[0] === "cmd_ai_ask" && (c[1] as { depth?: string }).depth === depth,
  );
}
function lastChannel(): MockChannelT {
  const call = [...mocks.invoke.mock.calls].reverse().find((c) => c[0] === "cmd_ai_ask");
  if (!call) throw new Error("cmd_ai_ask was never called");
  return (call[1] as { onEvent: MockChannelT }).onEvent;
}
async function pushDelta(ch: MockChannelT, text: string) {
  await act(async () => { ch.onmessage?.({ kind: "delta", text }); });
}
async function pushDone(ch: MockChannelT) {
  await act(async () => { ch.onmessage?.({ kind: "done" }); });
}

const card = (over: Partial<TutorDraft> = {}) => (
  <MarginTutorCard bookId="bk1" draft={baseDraft(over)} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} />
);

describe("MarginTutorCard — opt-in gate", () => {
  it("does NOT call the model until the reader enables the tutor", async () => {
    render(card());
    expect(await screen.findByText(/Enable the tutor/i)).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());

    fireEvent.click(screen.getByText("Enable"));
    // First call is the BRIEF tier, in the draft's lens.
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "cmd_ai_ask",
        expect.objectContaining({ mode: "explain", depth: "brief", selection: "the unjust man is happy" }),
      ),
    );
    expect(localStorage.getItem("tl.tutorEnabled")).toBe("true");
  });
});

describe("MarginTutorCard — brief default + go deeper", () => {
  beforeEach(() => localStorage.setItem("tl.tutorEnabled", "true"));

  it("streams a BRIEF answer immediately and shows 'Go deeper' (no prompt surface)", async () => {
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    const ch = lastChannel();
    await pushDelta(ch, "Augustine asks whether one must know God to call on him.");
    await pushDone(ch);

    expect(screen.getByText(/whether one must know God/)).toBeInTheDocument();
    // The default is brief — no deep call yet, and 'Go deeper' is offered.
    expect(asksOfDepth("deep").length).toBe(0);
    expect(await screen.findByText(/Go deeper/i)).toBeInTheDocument();
    // Privacy: no prompt-preview surface, and the no-network command is unused.
    expect(screen.queryByText(/nothing is sent/i)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_generate_prompt_preview", expect.anything());
  });

  it("'Go deeper' fires a DEEP call and APPENDS below the brief (gist stays)", async () => {
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "Brief gist of the passage.");
    await pushDone(lastChannel());

    fireEvent.click(await screen.findByText(/Go deeper/i));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.objectContaining({ mode: "explain", depth: "deep" })),
    );
    await pushDelta(lastChannel(), "The deeper reasoning move beneath it.");
    await pushDone(lastChannel());

    // Both tiers are on screen: the brief gist persists as an anchor.
    expect(screen.getByText(/Brief gist of the passage\./)).toBeInTheDocument();
    expect(screen.getByText(/The deeper reasoning move beneath it\./)).toBeInTheDocument();
    // The "Deeper" divider marks the appended tier.
    expect(screen.getByText("Deeper")).toBeInTheDocument();
    // After deep, the deepest tier bottoms out: 'Go deeper' is replaced by
    // 'Question me' (Socratic), the panel's terminal active move.
    expect(screen.queryByText(/Go deeper/i)).toBeNull();
    expect(screen.getByText(/Question me/i)).toBeInTheDocument();
  });

  it("saves brief + deep + optional takeaway as one TutorNote", async () => {
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "Brief gist.");
    await pushDone(lastChannel());
    fireEvent.click(await screen.findByText(/Go deeper/i));
    await waitFor(() => expect(asksOfDepth("deep").length).toBe(1));
    await pushDelta(lastChannel(), "Deeper elaboration.");
    await pushDone(lastChannel());

    fireEvent.click(await screen.findByText("Save as note"));
    fireEvent.change(screen.getByPlaceholderText(/your takeaway/i), { target: { value: "my words" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      const call = mocks.invoke.mock.calls.find((c) => c[0] === "cmd_save_ai_response_as_note");
      expect((call?.[1] as { body: string }).body).toBe("my words\n\nBrief gist.\n\nDeeper elaboration.");
      expect(call?.[1]).toMatchObject({ noteType: "TutorNote", anchoredText: "the unjust man is happy" });
    });
    expect(await screen.findByText(/Saved to notes/i)).toBeInTheDocument();
  });

  it("'Ask another way' switches lens and resets to a BRIEF call", async () => {
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "First.");
    await pushDone(lastChannel());

    fireEvent.click(await screen.findByText("Define"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.objectContaining({ mode: "vocabulary", depth: "brief" })),
    );
  });
});

describe("MarginTutorCard — quote chip", () => {
  it("shows the passage itself, never a raw char: locator", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const { container } = render(card());
    // The quote is the anchor the reader cares about…
    expect(await screen.findByText(/the unjust man is happy/)).toBeInTheDocument();
    // …and the chip carries no locator plumbing.
    const chip = container.querySelector(".tl-quotechip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).not.toMatch(/char:/);
  });
});

describe("MarginTutorCard — cap-hit three doors (CM6)", () => {
  // Company mode, proxy says the allowance is spent: cmd_ai_ask rejects with
  // CapExhausted BEFORE any stream — the card must show three doors, free first.
  function setCapHit() {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.reject({ kind: "CapExhausted" });
        case "cmd_company_checkout":
          return Promise.resolve("https://checkout.stripe.com/c/pay/cs_test_x");
        case "cmd_company_credits":
          return Promise.resolve({ status: "exhausted", remaining_fraction: 0, approx_questions_left: 0 });
        default:
          return Promise.resolve(null);
      }
    });
  }

  beforeEach(() => {
    localStorage.setItem("tl.tutorEnabled", "true");
    setCapHit();
  });

  it("renders the three doors with the free path as the only primary", async () => {
    render(card());
    expect(await screen.findByText(/included Throughline AI is used up/i)).toBeInTheDocument();
    // PRIMARY: the free door (AiSetupSheet with cap framing) holds the only
    // tl-btn-primary on the screen.
    expect(screen.getByText("Keep going free")).toBeInTheDocument();
    const freeBtn = screen.getByRole("button", { name: /Paste API key & ask/i });
    expect(freeBtn.className).toContain("tl-btn-primary");
    // SECONDARY: the $20 door is a ghost button, never primary.
    const buyBtn = screen.getByRole("button", { name: /another full allowance — \$20/i });
    expect(buyBtn.className).not.toContain("tl-btn-primary");
    // TERTIARY: the quiet mailto link.
    expect(screen.getByRole("button", { name: /Let me know/i })).toBeInTheDocument();
    // The stale "nothing has been sent" framing must not appear at the cap.
    expect(screen.queryByText(/Nothing has been sent/i)).toBeNull();
  });

  it("the $20 door reuses the buy→activate flow and offers a retry", async () => {
    render(card());
    fireEvent.click(await screen.findByRole("button", { name: /another full allowance — \$20/i }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_company_checkout"));
    expect(await screen.findByText(/Opening checkout in your browser/i)).toBeInTheDocument();
    // "try again" clears the cap state and refires the lens.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.objectContaining({ depth: "brief" })),
    );
  });

  it("the quiet door opens the fixed support email (no payload from the app)", async () => {
    render(card());
    fireEvent.click(await screen.findByRole("button", { name: /Let me know/i }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_open_support_email"));
  });
});

describe("MarginTutorCard — first-cloud-send consent copy", () => {
  // The backend pauses the first cloud send with NeedsCloudConsent; the dialog
  // must describe the reader's actual arrangement (key / login / purchase) —
  // reusing the AI_PROVIDERS disclosure so it never drifts from the picker.
  function setConsentNeeded(provider: string, host: string) {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: provider, ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.reject({ kind: "NeedsCloudConsent", host });
        default:
          return Promise.resolve(null);
      }
    });
  }

  async function consentDialog(provider: string, host: string) {
    localStorage.setItem("tl.tutorEnabled", "true");
    setConsentNeeded(provider, host);
    render(card());
    return await screen.findByRole("dialog", { name: /Confirm cloud AI/i });
  }

  it("Codex: names the reader's login, never an API key they don't have", async () => {
    const dialog = await consentDialog("codex", "chatgpt.com");
    expect(dialog.textContent).toMatch(/via your Codex login/i);
    expect(dialog.textContent).not.toMatch(/API key/i);
    expect(dialog.textContent).toContain("Your book file never leaves this Mac.");
  });

  it("company mode: names the one-time purchase, never an API key", async () => {
    const dialog = await consentDialog("company", "ai.readthroughline.com");
    expect(dialog.textContent).toMatch(/under your one-time purchase/i);
    expect(dialog.textContent).not.toMatch(/API key/i);
    expect(dialog.textContent).toContain("Your book file never leaves this Mac.");
  });

  it("Anthropic keeps 'under your API key' (pins the BYO copy)", async () => {
    const dialog = await consentDialog("anthropic", "api.anthropic.com");
    expect(dialog.textContent).toMatch(/under your API key/i);
    expect(dialog.textContent).toContain("Your book file never leaves this Mac.");
  });

  it("OpenAI keeps 'under your API key' (pins the BYO copy)", async () => {
    const dialog = await consentDialog("openai", "api.openai.com");
    expect(dialog.textContent).toMatch(/under your API key/i);
    expect(dialog.textContent).toContain("Your book file never leaves this Mac.");
  });
});

describe("MarginTutorCard — provider gate", () => {
  // No AI provider chosen → the tutor must refuse to call and say so.
  function setNoProvider() {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "none", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "" });
        default:
          return Promise.resolve(null);
      }
    });
  }

  it("when no provider is chosen, does NOT call cmd_ai_ask and shows the cold-start setup sheet", async () => {
    localStorage.setItem("tl.tutorEnabled", "true"); // would normally auto-start
    setNoProvider();
    render(card());
    // The dead-end "Choose one in Settings" message is replaced by setup-at-intent.
    expect(await screen.findByText(/Tutor not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/Paste API key & ask/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_get_settings"));
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
    expect(screen.queryByText(/nothing leaves your device/i)).toBeNull();
    expect(screen.queryByText(/^Local-only$/)).toBeNull();
  });

  it("at the consent gate with no provider, shows the setup sheet (no false on-device promise)", async () => {
    setNoProvider();
    render(card());
    expect(await screen.findByText(/Tutor not connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing leaves your device/i)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
  });

  it("when a CLOUD provider is chosen, the tutor IS allowed (calls cmd_ai_ask) and never claims local", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "openai", ai_model_openai: "gpt-5.5", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "api.openai.com" });
        default:
          return Promise.resolve(null);
      }
    });
    render(card());
    // Cloud provider chosen → the call goes through (the privacy choice was explicit).
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    // And the UI must never falsely claim on-device for a cloud call.
    expect(screen.queryByText(/^Local-only$/)).toBeNull();
  });
});

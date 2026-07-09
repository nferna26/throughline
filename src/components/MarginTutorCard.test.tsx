import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import MarginTutorCard, { tutorPrivacyLine, type TutorDraft } from "./MarginTutorCard";

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

  it("the answer region is aria-live polite and toggles aria-busy across the stream (CORE-1158)", async () => {
    const { container } = render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    const ch = lastChannel();
    await pushDelta(ch, "Streaming this in…");
    const live = container.querySelector('.tl-tutor-answer[aria-live="polite"]') as HTMLElement;
    expect(live).not.toBeNull();
    // While streaming → busy, so a screen reader holds the announcement and reads
    // the finished brief as ONE chunk rather than token by token.
    expect(live.getAttribute("aria-busy")).toBe("true");
    await pushDone(ch);
    expect(live.getAttribute("aria-busy")).toBe("false");
  });

  it("renders NO streaming caret under reduced motion — the answer reads pre-resolved (CORE-1158)", async () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: /reduce/.test(q),
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    })) as typeof window.matchMedia;
    try {
      const { container } = render(card());
      await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
      await pushDelta(lastChannel(), "An answer with no caret.");
      // The text streams in, but no caret element is ever placed in the DOM.
      expect(screen.getByText(/no caret/)).toBeInTheDocument();
      expect(container.querySelector(".tl-caret")).toBeNull();
    } finally {
      window.matchMedia = orig;
    }
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
    // After deep, the deepest tier bottoms out: 'Go deeper' is gone (hidden after
    // 2 tiers). The Socratic turn is no longer a duplicate "Question me" button —
    // it's the same action as the Socratic lens chip, whose visible label is now
    // "Ask" (shortened so all four chips fit one row at 340px).
    expect(screen.queryByText(/Go deeper/i)).toBeNull();
    expect(screen.queryByText(/Question me/i)).toBeNull();
    expect(screen.getByRole("radio", { name: "Ask" })).toBeInTheDocument();
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

    // The footer accent button opens the save form…
    fireEvent.click(await screen.findByRole("button", { name: "Save as note" }));
    fireEvent.change(screen.getByPlaceholderText(/your takeaway/i), { target: { value: "my words" } });
    // …and the form's confirm button persists the note.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

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

describe("MarginTutorCard: lens-row affordance + header repair (grow-in-flow handoff)", () => {
  beforeEach(() => localStorage.setItem("tl.tutorEnabled", "true"));

  async function toDone() {
    const { container } = render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "Brief gist of the passage.");
    await pushDone(lastChannel());
    await screen.findByRole("button", { name: "Save as note" });
    return container;
  }

  it("the active lens is the accent-filled pill (handoff: the lens row is the primary affordance)", async () => {
    const container = await toDone();
    const active = container.querySelector(".tl-lenschip.is-active") as HTMLElement;
    expect(active).not.toBeNull();
    expect(active.textContent).toBe("Explain"); // the draft's lens
    expect(active.getAttribute("aria-checked")).toBe("true");
    // Exactly one lens is active (filled) at a time.
    expect(container.querySelectorAll(".tl-lenschip.is-active").length).toBe(1);
  });

  it("Save is a quiet text button, not the card's fill (handoff .sbtn)", async () => {
    const container = await toDone();
    const save = container.querySelector(".tl-tutor-save") as HTMLElement;
    expect(save).not.toBeNull();
    expect(save.textContent).toMatch(/Save as note/);
    // The fill lives on the active lens chip, never on Save.
    expect(save.classList.contains("is-active")).toBe(false);
    expect(save.classList.contains("tl-lenschip")).toBe(false);
  });

  it("Regenerate is a header icon button (absent while streaming, present when done)", async () => {
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    // While streaming, the header shows the thinking indicator, not Regenerate.
    expect(screen.queryByRole("button", { name: /Regenerate/i })).toBeNull();
    await pushDelta(lastChannel(), "Brief gist.");
    await pushDone(lastChannel());
    // Done → Regenerate appears as a header icon button and re-fires the lens.
    const regen = await screen.findByRole("button", { name: "Regenerate answer" });
    expect(regen.className).toContain("tl-iconbtn");
    fireEvent.click(regen);
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(2));
  });
});

describe("tutorPrivacyLine (mode-aware microcopy, CORE-1190)", () => {
  it("differs correctly by provider mode", () => {
    expect(tutorPrivacyLine("local")).toBe("Answered on this Mac.");
    expect(tutorPrivacyLine("company")).toBe(
      "Your selection was sent to the Throughline assistant, nothing kept.",
    );
    expect(tutorPrivacyLine("openai")).toBe("Your selection was sent to OpenAI using your key.");
    expect(tutorPrivacyLine("anthropic")).toBe(
      "Your selection was sent to Anthropic using your key.",
    );
    expect(tutorPrivacyLine("codex")).toBe(
      "Your selection was sent to OpenAI through your ChatGPT sign-in.",
    );
    // Unknown / not-yet-loaded: say only what is certain.
    expect(tutorPrivacyLine(null)).toBe("Your selection was sent to your AI provider.");
  });

  it("only the company line may claim retention; only local may claim on-device", () => {
    for (const p of ["openai", "anthropic", "codex", null]) {
      const line = tutorPrivacyLine(p);
      expect(line).not.toMatch(/nothing kept/i);
      expect(line).not.toMatch(/Throughline assistant/i);
      expect(line).not.toMatch(/on this Mac/i);
    }
    // No em dashes anywhere in reader-facing microcopy.
    for (const p of ["local", "company", "openai", "anthropic", "codex", null]) {
      expect(tutorPrivacyLine(p)).not.toContain("—");
    }
  });
});

describe("MarginTutorCard — privacy microline honesty (handoff)", () => {
  it("a LOCAL answer reads 'Answered on this Mac.'", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    render(card()); // default mock provider is "local"
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "Local gist.");
    await pushDone(lastChannel());
    expect(await screen.findByText("Answered on this Mac.")).toBeInTheDocument();
    // It must NOT claim the selection was sent anywhere.
    expect(screen.queryByText(/sent to the Throughline assistant/i)).toBeNull();
  });

  // CORE-1190: the microline must be honest per MODE. Company mode goes through
  // Throughline's stateless relay, so "nothing kept" is a promise we can make.
  // BYO goes to the READER'S OWN provider account; Throughline cannot promise a
  // third party's retention, so the line names the provider and claims nothing.
  function setCloudProvider(provider: string, host: string) {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: provider, ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: host });
        default:
          return Promise.resolve(null);
      }
    });
  }

  async function renderToDone() {
    render(card());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    await pushDelta(lastChannel(), "Cloud gist.");
    await pushDone(lastChannel());
  }

  it("a COMPANY answer names the Throughline assistant + 'nothing kept', never 'Answered on this Mac'", async () => {
    setCloudProvider("company", "ai.readthroughline.com");
    await renderToDone();
    expect(
      await screen.findByText("Your selection was sent to the Throughline assistant, nothing kept."),
    ).toBeInTheDocument();
    // Never imply on-device for a cloud answer.
    expect(screen.queryByText(/Answered on this Mac/i)).toBeNull();
  });

  it("a BYO answer names the READER'S OWN provider and makes no retention claim", async () => {
    setCloudProvider("openai", "api.openai.com");
    await renderToDone();
    expect(
      await screen.findByText("Your selection was sent to OpenAI using your key."),
    ).toBeInTheDocument();
    // BYO must not claim Throughline handled it, promise a third party's
    // retention, or imply on-device.
    expect(screen.queryByText(/Throughline assistant/i)).toBeNull();
    expect(screen.queryByText(/nothing kept/i)).toBeNull();
    expect(screen.queryByText(/Answered on this Mac/i)).toBeNull();
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
    expect(await screen.findByText(/You've used the generous tutoring included with your license/i)).toBeInTheDocument();
    // PRIMARY: the free door (AiSetupSheet with cap framing) holds the only
    // tl-btn-primary on the screen.
    expect(screen.getByText("Keep going free")).toBeInTheDocument();
    const freeBtn = screen.getByRole("button", { name: /Paste API key & ask/i });
    expect(freeBtn.className).toContain("tl-btn-primary");
    // SECONDARY: the $20 door is a ghost button, never primary.
    const buyBtn = screen.getByRole("button", { name: /another full allowance for \$20/i });
    expect(buyBtn.className).not.toContain("tl-btn-primary");
    // TERTIARY: the quiet mailto link.
    expect(screen.getByRole("button", { name: /Reply to your purchase email/i })).toBeInTheDocument();
    // The stale "nothing has been sent" framing must not appear at the cap.
    expect(screen.queryByText(/Nothing has been sent/i)).toBeNull();
  });

  it("renders NO raw allowance number, percent, or progress bar (no-counter rule)", async () => {
    const { container } = render(card());
    await screen.findByText(/You've used the generous tutoring included with your license/i);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector(".meter, .meter-fill, .tl-fuel-bar, .fill")).toBeNull();
    const text = container.textContent ?? "";
    // No usage count (the cap mock returns 0/0); the $20 price is allowed (re-purchase, not a meter).
    expect(text).not.toMatch(/\b\d+\s*(questions|left|remaining)\b/i);
    expect(text).not.toMatch(/%/);
  });

  it("the $20 door reuses the buy→activate flow and offers a retry", async () => {
    render(card());
    fireEvent.click(await screen.findByRole("button", { name: /another full allowance for \$20/i }));
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
    fireEvent.click(await screen.findByRole("button", { name: /Reply to your purchase email/i }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_open_support_email"));
  });
});

describe("MarginTutorCard — company outage voice (CORE-1037)", () => {
  it("a company outage opens the paused sheet in Throughline AI's voice — truthful, no key-pasting CTA", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "ai.readthroughline.com" });
        default:
          return Promise.resolve(null);
      }
    });
    render(card());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    const ch = lastChannel();
    // The relay went quiet AFTER the send — the audit row for this minute says Sent →.
    await act(async () => { ch.onmessage?.({ kind: "error", message: "Throughline AI request failed: connection refused" }); });
    expect(await screen.findByText(/Throughline AI hit a snag/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been sent/i)).toBeNull();
    expect(screen.queryByText(/Switch provider/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Check again/i })).toBeInTheDocument();
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
    expect(screen.queryByText(/^On this Mac$/)).toBeNull();
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
    expect(screen.queryByText(/^On this Mac$/)).toBeNull();
  });
});

describe("MarginTutorCard: instant cached reopen (CORE-1163)", () => {
  beforeEach(() => localStorage.setItem("tl.tutorEnabled", "true"));

  it("replays a cached brief and issues NO cmd_ai_ask on reopen", async () => {
    render(
      card({
        cache: {
          lens: "explain",
          brief: "Aurelius braces himself for the day.",
          deep: "",
          deepRequested: false,
          aiRequestId: "ai_prev",
          collapsed: false,
        },
      }),
    );
    // The cached answer renders immediately (phase "done", replayed)...
    expect(await screen.findByText(/Aurelius braces himself/)).toBeInTheDocument();
    // ...and the model was never called (no re-spend), even though the tutor is enabled.
    expect(mocks.invoke.mock.calls.some((c) => c[0] === "cmd_ai_ask")).toBe(false);
    // A done brief with no deep still offers Go deeper.
    expect(screen.getByText(/Go deeper/i)).toBeInTheDocument();
  });

  it("restores the deep tier from cache without re-calling (the deep is not lost)", async () => {
    render(
      card({
        mode: "explain",
        cache: {
          lens: "historical",
          brief: "The brief gist.",
          deep: "The deeper reasoning beneath it.",
          deepRequested: true,
          aiRequestId: "ai_prev",
          collapsed: false,
        },
      }),
    );
    expect(await screen.findByText(/The deeper reasoning beneath it/)).toBeInTheDocument();
    expect(screen.getByText(/The brief gist/)).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some((c) => c[0] === "cmd_ai_ask")).toBe(false);
  });

  it("still calls the model on a genuine first open (no cache)", async () => {
    render(card()); // no cache
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
  });
});

// ── P1-3: an interrupted stream must never lead to a SILENT second paid call ──
// Money-path regression. The relay bills the answer as it streams; before this
// fix, unmounting the card mid-stream (a second question, a kept-marker click,
// section nav) dropped the answer AND never cached it, so reopening auto-fired a
// FRESH cmd_ai_ask and the reader paid twice. The card fix persists an interrupted
// snapshot so reopen replays instead of re-charging. The $8 cap itself is relay-
// side and untouched by this change (its own cap.test.ts still passes); these
// tests prove the app no longer emits the second billable call, and that a normal
// single ask still fires exactly one.
import { setTutorEnabled } from "../tutorConsent";
import { type TutorCache } from "./MarginTutorCard";

function totalAsks() {
  return mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;
}

describe("MarginTutorCard — P1-3 interrupted stream never double-charges", () => {
  it("mid-stream unmount persists an interrupted cache; reopen replays with no 2nd cmd_ai_ask", async () => {
    setTutorEnabled(true);
    let saved: TutorCache | undefined;
    const onCached = vi.fn((_id: string, c: TutorCache) => { saved = c; });
    const draft = baseDraft();
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={draft} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    // The brief call auto-fired and the stream is live (one delta arrived).
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    const ch = lastChannel();
    await pushDelta(ch, "partial answer so far");
    expect(totalAsks()).toBe(1);

    // Reader switches cards -> this card unmounts mid-stream (before "done").
    unmount();
    // An interrupted snapshot was persisted with the partial text.
    expect(onCached).toHaveBeenCalledTimes(1);
    expect(saved?.interrupted).toBe(true);
    expect(saved?.brief).toContain("partial answer so far");

    // Reopen the SAME draft carrying that interrupted cache.
    const asksBefore = totalAsks();
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: saved })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    // Give any mount effect a chance to (wrongly) fire a call.
    await act(async () => { await Promise.resolve(); });
    expect(totalAsks()).toBe(asksBefore); // NO second paid call — double-charge gone
    // The partial answer is replayed, with an honest interrupted hint + explicit re-ask.
    expect(screen.getByText(/partial answer so far/)).toBeInTheDocument();
    expect(screen.getByText(/interrupted/i)).toBeInTheDocument();
  });

  it("a normal single ask fires exactly one cmd_ai_ask and completes to a clean (non-interrupted) cache", async () => {
    setTutorEnabled(true);
    const onCached = vi.fn();
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    const ch = lastChannel();
    await pushDelta(ch, "the whole answer");
    await pushDone(ch);

    expect(totalAsks()).toBe(1); // exactly one billable call
    await waitFor(() => expect(onCached).toHaveBeenCalled());
    const calls = onCached.mock.calls;
    const lastCache = calls[calls.length - 1]?.[1] as TutorCache;
    expect(lastCache.interrupted).toBeFalsy();
    expect(lastCache.brief).toContain("the whole answer");
  });

  it("replaying an interrupted card never re-charges and never silently heals the flag", async () => {
    setTutorEnabled(true);
    const interrupted: TutorCache = {
      lens: "explain", brief: "partial", deep: "", deepRequested: false,
      aiRequestId: null, collapsed: false, interrupted: true,
    };
    const onCached = vi.fn();
    const asksBefore = totalAsks();
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: interrupted })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    unmount();
    // Never fires a billable call on pure replay.
    expect(totalAsks()).toBe(asksBefore);
    // Any idempotent re-persist MUST keep interrupted=true — a partial answer must
    // not be silently promoted to complete without a deliberate re-ask.
    for (const c of onCached.mock.calls) {
      expect((c[1] as TutorCache).interrupted).toBe(true);
    }
  });
});

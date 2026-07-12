import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act, within } from "@testing-library/react";
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
        return Promise.resolve({ note: { id: "note_1", note_type: "TutorNote" }, export: { ok: true, message: null } });
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

  it("a rejected save renders its error IN the save form (current phase), keeps the takeaway, and Save retries (DATA-005)", async () => {
    let saveCalls = 0;
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "cmd_save_ai_response_as_note") {
        saveCalls += 1;
        return saveCalls === 1
          ? Promise.reject({ message: "database is locked" })
          : Promise.resolve({ note: { id: "note_1", note_type: "TutorNote" }, export: { ok: true, message: null } });
      }
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "gemma-4-31b-it-mlx", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "localhost" });
        case "cmd_test_ai_connection":
          return Promise.resolve({ reachable: true, first_model_id: "gemma-4-31b-it-mlx", message: "ok" });
        default:
          return Promise.resolve(null);
      }
    });
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "Brief gist.");
    await pushDone(lastChannel());

    fireEvent.click(await screen.findByRole("button", { name: "Save as note" }));
    fireEvent.change(screen.getByPlaceholderText(/your takeaway/i), { target: { value: "my words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The failure renders HERE, in the save form the reader is looking at —
    // not in the unreachable phase==="error" branch.
    const err = await screen.findByRole("alert");
    expect(err.textContent).toMatch(/Couldn't save this to your notes/i);
    // The takeaway is retained and Save is ready to retry.
    expect(screen.getByDisplayValue("my words")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved to notes/i)).toBeInTheDocument();
    expect(saveCalls).toBe(2);
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

describe("tutorPrivacyLine (mode-aware microcopy, CORE-1190/R9-6/R9-7)", () => {
  it("differs correctly by provider mode", () => {
    expect(tutorPrivacyLine(["local"])).toBe("Answered on this Mac.");
    // R9-7: the RELAY grammatically governs the retention claim — it is the
    // subject of "does not log or store", never a vague trailing clause.
    expect(tutorPrivacyLine(["company"])).toBe(
      "Your selection went through Throughline's relay, which does not log or store it.",
    );
    expect(tutorPrivacyLine(["openai"])).toBe("Your selection was sent to OpenAI using your key.");
    expect(tutorPrivacyLine(["anthropic"])).toBe(
      "Your selection was sent to Anthropic using your key.",
    );
    expect(tutorPrivacyLine(["codex"])).toBe(
      "Your selection was sent to OpenAI through your ChatGPT sign-in.",
    );
    // Unknown / not-yet-loaded: say only what is certain.
    expect(tutorPrivacyLine([null])).toBe("Your selection was sent to your AI provider.");
    expect(tutorPrivacyLine([])).toBe("Your selection was sent to your AI provider.");
  });

  it("only the company line may claim retention; only local may claim on-device", () => {
    for (const p of [["openai"], ["anthropic"], ["codex"], [null]] as Array<Array<string | null>>) {
      const line = tutorPrivacyLine(p);
      expect(line).not.toMatch(/does not log or store/i);
      expect(line).not.toMatch(/relay/i);
      expect(line).not.toMatch(/on this Mac/i);
    }
  });

  // ── R9-6: MIXED-provider cards (brief and deep from different places) ──

  it("a MIXED company+BYO card enumerates both and never stretches the relay promise across the BYO tier", () => {
    const line = tutorPrivacyLine(["company", "openai"]);
    expect(line).toContain("Throughline's relay");
    expect(line).toContain("OpenAI (your key)");
    expect(line).not.toMatch(/does not log or store/i);
    expect(line).not.toBe("Answered on this Mac.");
  });

  it("a MIXED local+cloud card never claims 'Answered on this Mac.'", () => {
    const line = tutorPrivacyLine(["local", "anthropic"]);
    expect(line).not.toBe("Answered on this Mac.");
    expect(line).toContain("the local model on this Mac");
    expect(line).toContain("Anthropic (your key)");
    expect(line).not.toMatch(/does not log or store/i);
  });

  it("a MIXED card with any UNKNOWN tier falls back to the neutral line", () => {
    expect(tutorPrivacyLine(["company", null])).toBe(
      "Your selection was sent to your AI provider.",
    );
  });

  it("duplicate tiers from the SAME provider stay a single-provider line", () => {
    expect(tutorPrivacyLine(["openai", "openai"])).toBe(
      "Your selection was sent to OpenAI using your key.",
    );
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

  // CORE-1190/R9-7: the microline must be honest per MODE. Company mode goes
  // through Throughline's stateless relay, and the RELAY is the grammatical
  // subject of the no-log/no-store claim.
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

  it("a COMPANY answer names Throughline's relay as the subject of the retention claim, never 'Answered on this Mac' (R9-7)", async () => {
    setCloudProvider("company", "ai.readthroughline.com");
    await renderToDone();
    expect(
      await screen.findByText(
        "Your selection went through Throughline's relay, which does not log or store it.",
      ),
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
    expect(screen.queryByText(/Throughline's relay/i)).toBeNull();
    expect(screen.queryByText(/does not log or store/i)).toBeNull();
    expect(screen.queryByText(/Answered on this Mac/i)).toBeNull();
  });

  it("after PROVIDER DRIFT the settled line names the ask's REPORTED destination, not mount-time state (R7-9)", async () => {
    // Settings said Anthropic at mount, but the backend resolved (and
    // audited) the ask to OpenAI — the settled attribution must follow the
    // returned provider_host.
    setCloudProvider("anthropic", "api.openai.com");
    await renderToDone();
    expect(
      await screen.findByText("Your selection was sent to OpenAI using your key."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sent to Anthropic/i)).toBeNull();
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
    return await screen.findByRole("dialog", { name: /Send this passage to/i });
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

describe("MarginTutorCard — consent sheet accessibility + exact disclosure (PRIV-A11Y-009)", () => {
  const LONG_SELECTION = "long passage sentence. ".repeat(30).trim(); // ~690 chars > the old 220 cap

  /** A gate backend mirroring the REAL R6-1 send boundary: the envelope
   *  carries a backend-issued binding {provider, host, fingerprint}; a
   *  cmd_ai_ask without remembered consent validates that binding against the
   *  backend's CURRENT state and records consent only on an exact match —
   *  any drift rejects NeedsCloudConsent naming the current host, with zero
   *  egress and nothing armed. */
  function makeGateBackend(opts?: {
    envelopeFails?: () => boolean;
    askHangs?: boolean;
    boundAskFailsOnce?: { message: string };
    onFirstGateReject?: () => void;
  }) {
    const state = {
      provider: "anthropic",
      host: "api.anthropic.com",
      consented: false,
      gateRejections: 0,
      resolveHung: null as null | (() => void),
    };
    const fp = (selection: string) => `fp:${state.provider}:${state.host}:${selection.length}`;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string, rawArgs?: unknown) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: state.provider, ai_requests_retention_days: 90 });
        case "cmd_outbound_envelope": {
          if (opts?.envelopeFails?.()) return Promise.reject({ message: "backend hiccup" });
          const selection = String(args.selection ?? "");
          return Promise.resolve({
            host: state.host,
            provider: state.provider,
            fingerprint: fp(selection),
            envelope: {
              book_title: "Meditations",
              author: "Marcus Aurelius",
              chapter: "Book II",
              selection_bounded: selection,
              prompt: "FULL PROMPT TEXT " + selection,
            },
          });
        }
        case "cmd_ai_ask": {
          const selection = String(args.selection ?? "");
          if (!state.consented) {
            const b = args.consent as { provider: string; host: string; fingerprint: string } | null;
            const bound =
              b && b.provider === state.provider && b.host === state.host && b.fingerprint === fp(selection);
            if (!bound) {
              state.gateRejections += 1;
              if (state.gateRejections === 1) opts?.onFirstGateReject?.();
              return Promise.reject({ kind: "NeedsCloudConsent", host: state.host });
            }
            if (opts?.boundAskFailsOnce) {
              const failure = opts.boundAskFailsOnce;
              opts.boundAskFailsOnce = undefined;
              // Validation reached but the durable consent write failed —
              // nothing armed, nothing sent (mirrors enforce_bound_cloud_consent's `?`).
              return Promise.reject({ kind: "Db", message: failure.message });
            }
            state.consented = true;
          }
          const resolved = { ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: state.host };
          if (opts?.askHangs) return new Promise((res) => { state.resolveHung = () => res(resolved); });
          return Promise.resolve(resolved);
        }
        default:
          return Promise.resolve(null);
      }
    });
    return state;
  }

  const askCalls = () => mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask");
  const boundAskCalls = () =>
    askCalls().filter((c) => (c[1] as Record<string, unknown> | undefined)?.consent != null);

  function setConsent(withEnvelope: boolean) {
    makeGateBackend({ envelopeFails: () => !withEnvelope });
  }

  async function openSheet(withEnvelope = true) {
    localStorage.setItem("tl.tutorEnabled", "true");
    setConsent(withEnvelope);
    render(card({ anchoredText: LONG_SELECTION }));
    return await screen.findByRole("dialog", { name: /Send this passage to/i });
  }

  it("puts dialog semantics on the sheet and focuses 'Not now' (the safe choice) first", async () => {
    const dialog = await openSheet();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
    const notNow = within(dialog).getByRole("button", { name: "Not now" });
    await waitFor(() => expect(document.activeElement).toBe(notNow));
  });

  it("traps Tab and Shift+Tab inside the sheet", async () => {
    const dialog = await openSheet();
    const notNow = within(dialog).getByRole("button", { name: "Not now" });
    await waitFor(() => expect(document.activeElement).toBe(notNow));
    // jsdom can't compute visibility (offsetParent), so the honest assertion
    // here is the trap PROPERTY: focus never escapes the sheet in either
    // direction. (Exact wrap order is covered by useDialog's shared logic.)
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("Escape cancels without sending, and nothing is confirmed before explicit activation", async () => {
    const dialog = await openSheet();
    await within(dialog).findByText(/exactly as it will be sent/i);
    // Only the gate rejection has happened — no ask ever carried a binding.
    expect(askCalls()).toHaveLength(1);
    expect(boundAskCalls()).toHaveLength(0);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Send this passage to/i })).toBeNull(),
    );
    expect(askCalls()).toHaveLength(1);
    expect(boundAskCalls()).toHaveLength(0);
    // The card says what happened instead of silently vanishing.
    expect(await screen.findByText(/wasn't confirmed/i)).toBeInTheDocument();
  });

  it("restores focus to the invoking tutor card when the sheet closes", async () => {
    // The card takes focus on mount (A11Y-010), so IT is the invoker the sheet
    // must restore to — the keyboard reader lands back on the card that asked.
    const dialog = await openSheet();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Send this passage to/i })).toBeNull(),
    );
    const invokerCard = screen.getByRole("complementary", { name: /Tutor — Explain/i });
    await waitFor(() => expect(invokerCard.contains(document.activeElement) || document.activeElement === invokerCard).toBe(true));
  });

  it("discloses the destination, every book-derived field, and the FULL bounded selection — not a 220-character substitute", async () => {
    const dialog = await openSheet();
    await within(dialog).findByText(/exactly as it will be sent/i);
    expect(dialog.textContent).toContain("api.anthropic.com");
    expect(dialog.textContent).toContain("Book: Meditations by Marcus Aurelius");
    expect(dialog.textContent).toContain("Chapter: Book II");
    // The ENTIRE bounded selection is present (both ends), not a prefix.
    expect(dialog.textContent).toContain(LONG_SELECTION);
    expect(LONG_SELECTION.length).toBeGreaterThan(220);
    // And the word-for-word request is inspectable.
    expect(within(dialog).getByText(/Show the full request, word for word/i)).toBeInTheDocument();
  });

  it("FAILS CLOSED when the envelope preview fails: Send disabled, Retry + Not now offered, zero consent/send", async () => {
    const dialog = await openSheet(false);
    // The failure is announced and the exact-preview promise is kept: no
    // passage is shown as "what will be sent" because nothing will be sent.
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/nothing will be sent/i);
    const send = within(dialog).getByRole("button", { name: /Send to api.anthropic.com/ });
    expect(send).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Not now" })).toBeEnabled();
    // A frustrated double-click on the disabled Send does nothing.
    fireEvent.click(send);
    fireEvent.click(send);
    expect(askCalls()).toHaveLength(1);
    expect(boundAskCalls()).toHaveLength(0);
  });

  it("Retry re-fetches the envelope; once it loads, Send fires exactly ONE ask carrying that envelope's binding", async () => {
    let envelopeCalls = 0;
    localStorage.setItem("tl.tutorEnabled", "true");
    const state = makeGateBackend({
      envelopeFails: () => {
        envelopeCalls += 1;
        return envelopeCalls === 1;
      },
    });
    render(card({ anchoredText: LONG_SELECTION }));
    const dialog = await screen.findByRole("dialog", { name: /Send this passage to/i });
    const alert = await within(dialog).findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: /Try again/i }));

    // The retried envelope loads → full disclosure + Send enabled.
    await within(dialog).findByText(/exactly as it will be sent/i);
    expect(dialog.textContent).toContain(LONG_SELECTION);
    const send = within(dialog).getByRole("button", { name: /Send to api.anthropic.com/ });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    // R6-1: the confirmed retry is the SAME command as the ask — one call,
    // carrying the exact backend-issued binding; the gate validated it and
    // recorded consent (no separate confirm round-trip exists).
    await waitFor(() => expect(askCalls()).toHaveLength(2));
    expect(boundAskCalls()).toHaveLength(1);
    expect((boundAskCalls()[0][1] as Record<string, unknown>).consent).toEqual({
      provider: "anthropic",
      host: "api.anthropic.com",
      fingerprint: `fp:anthropic:api.anthropic.com:${LONG_SELECTION.length}`,
    });
    expect(state.consented).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Send this passage to/i })).toBeNull(),
    );
  });

  it("a FAILED consent write at the send boundary is honest and recoverable — nothing armed, nothing streamed (R3→R6)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const state = makeGateBackend({ boundAskFailsOnce: { message: "database is locked" } });
    render(card({ anchoredText: LONG_SELECTION }));
    const dialog = await screen.findByRole("dialog", { name: /Send this passage to/i });
    const send = within(dialog).getByRole("button", { name: /Send to api.anthropic.com/ });
    await waitFor(() => expect(send).toBeEnabled());

    fireEvent.click(send);
    // The bound ask failed AT the boundary (consent write error): consent was
    // NOT recorded, nothing streamed, and the card says what happened instead
    // of pretending the reader consented.
    await waitFor(() => expect(askCalls()).toHaveLength(2));
    expect(state.consented).toBe(false);
    expect(await screen.findByText(/database is locked/i)).toBeInTheDocument();

    // Recoverable: asking again re-gates (consent was never armed), and the
    // fresh sheet's Send goes through.
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    const fresh = await screen.findByRole("dialog", { name: /Send this passage to/i });
    const send2 = within(fresh).getByRole("button", { name: /Send to api.anthropic.com/ });
    await waitFor(() => expect(send2).toBeEnabled());
    fireEvent.click(send2);
    await waitFor(() => expect(state.consented).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Send this passage to/i })).toBeNull(),
    );
  });

  it("Send is ATOMIC: one bound ask, no cancel window, late Escape neither cancels nor duplicates (R4→R6)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const state = makeGateBackend({ askHangs: true });
    render(card({ anchoredText: LONG_SELECTION }));
    const dialog = await screen.findByRole("dialog", { name: /Send this passage to/i });
    // Mode-aware copy: the lenses send a PASSAGE.
    expect(dialog).toHaveTextContent(/This is the passage, exactly as it will be sent/);
    const send = within(dialog).getByRole("button", { name: /Send to api.anthropic.com/ });
    await waitFor(() => expect(send).toBeEnabled());

    // R6-1: Send fires the ONE bound ask and the sheet closes with it — there
    // is no confirm-then-send window in which a cancel could race a consent
    // that then arms and sends after the reader said no (the R4 hazard is
    // structurally gone, not merely guarded).
    fireEvent.click(send);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Send this passage to/i })).toBeNull(),
    );
    await waitFor(() => expect(boundAskCalls()).toHaveLength(1));

    // A late Escape (the in-flight ask still settling) neither cancels the
    // authorized send nor fires a second one.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await act(async () => {});
    expect(boundAskCalls()).toHaveLength(1);

    await act(async () => { state.resolveHung!(); });
    expect(state.consented).toBe(true);
    expect(boundAskCalls()).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: /Send this passage to/i })).toBeNull();
  });

  it("PROVIDER DRIFT under the open sheet is rejected AT the send boundary: zero egress, nothing armed, fresh matching preview (R5→R6)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const state = makeGateBackend();
    render(card({ anchoredText: LONG_SELECTION }));
    const dialog = await screen.findByRole("dialog", { name: /Send this passage to/i });
    const send = within(dialog).getByRole("button", { name: /Send to api.anthropic.com/ });
    await waitFor(() => expect(send).toBeEnabled());

    // The provider changes UNDER the open sheet — after the preview the
    // reader is looking at, immediately before dispatch. The stale binding
    // reaches the send boundary and is refused THERE.
    state.provider = "openai";
    state.host = "api.openai.com";
    fireEvent.click(send);

    // Fails closed: the stale-bound ask was rejected (that rejection IS the
    // proof of zero egress — the mock only streams once consent validates),
    // no consent was armed for the NEW provider, and the sheet reopens with
    // the new destination and its fresh matching preview.
    const fresh = await screen.findByRole("dialog", { name: /Send this passage to api\.openai\.com/i });
    expect(state.consented).toBe(false);
    expect(boundAskCalls()).toHaveLength(1);
    await within(fresh).findByText(/exactly as it will be sent/i);
    expect(fresh).toHaveTextContent(/api\.openai\.com/);

    // Stable destination → the fresh binding validates, consent arms, streams.
    const send2 = within(fresh).getByRole("button", { name: /Send to api.openai.com/ });
    await waitFor(() => expect(send2).toBeEnabled());
    fireEvent.click(send2);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Send this passage to/i })).toBeNull(),
    );
    await waitFor(() => expect(state.consented).toBe(true));
    expect(boundAskCalls()).toHaveLength(2);
    expect((boundAskCalls()[1][1] as Record<string, unknown>).consent).toEqual({
      provider: "openai",
      host: "api.openai.com",
      fingerprint: `fp:openai:api.openai.com:${LONG_SELECTION.length}`,
    });
  });

  it("DRIFT BEFORE CONFIRMATION: the sheet re-binds host + preview together from the fresh envelope (R5)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    // The provider flips between the gate rejection (host A in the error) and
    // the envelope fetch — the sheet must show host B WITH B's preview and
    // Send must carry B's binding, never A's heading over B's payload.
    const state = makeGateBackend({
      onFirstGateReject: () => {
        state.provider = "openai";
        state.host = "api.openai.com";
      },
    });
    render(card({ anchoredText: LONG_SELECTION }));
    const dialog = await screen.findByRole("dialog", { name: /Send this passage to api\.openai\.com/i });
    await within(dialog).findByText(/exactly as it will be sent/i);
    const send = within(dialog).getByRole("button", { name: /Send to api.openai.com/ });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(state.consented).toBe(true));
    expect((boundAskCalls()[0][1] as Record<string, unknown>).consent).toEqual({
      provider: "openai",
      host: "api.openai.com",
      fingerprint: `fp:openai:api.openai.com:${LONG_SELECTION.length}`,
    });
  });

  it("the full-request disclosure is keyboard-reachable inside the trap", async () => {
    const dialog = await openSheet(true);
    await within(dialog).findByText(/exactly as it will be sent/i);
    const summary = within(dialog).getByText(/Show the full request, word for word/i);
    // Natively focusable and part of the trap: it takes focus, and Tab from it
    // keeps focus inside the dialog.
    (summary as HTMLElement).focus();
    expect(document.activeElement).toBe(summary);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
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

  it("a REPLAYED answer attributes from the CACHE, never current Settings, with no second ask (R8-4)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "cmd_get_settings") {
        // Settings have since drifted to Anthropic…
        return Promise.resolve({ export_path: "/x", ai_provider: "anthropic", ai_requests_retention_days: 90 });
      }
      return Promise.resolve(null);
    });
    render(
      card({
        cache: {
          lens: "explain",
          brief: "Aurelius braces himself for the day.",
          deep: "",
          deepRequested: false,
          aiRequestId: "ai_prev",
          collapsed: false,
          // …but THIS answer was audited to OpenAI when it streamed.
          answeredProvider: "openai",
        },
      }),
    );
    expect(await screen.findByText(/Aurelius braces himself/)).toBeInTheDocument();
    expect(
      screen.getByText("Your selection was sent to OpenAI using your key."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sent to Anthropic/i)).toBeNull();
    expect(mocks.invoke.mock.calls.some((c) => c[0] === "cmd_ai_ask")).toBe(false);
  });

  it("an UNKNOWN answered host renders the NEUTRAL line — never 'Answered on this Mac' (R8-4)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "local", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          // The backend reports a host the frontend cannot place.
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "proxy.internal.lan" });
        default:
          return Promise.resolve(null);
      }
    });
    render(card());
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: "an answer" }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    expect(screen.getByText("Your selection was sent to your AI provider.")).toBeInTheDocument();
    expect(screen.queryByText(/Answered on this Mac/i)).toBeNull();
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
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { saved = c ?? undefined; });
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

// ── R9-6: attempt identity + the DELAYED AskHandle window ──────────────────
// Deltas can stream on the channel BEFORE the cmd_ai_ask promise resolves its
// AskHandle. The pending state is armed at DISPATCH (not at handle receipt),
// so an unmount in that window still persists a neutral interrupted cache —
// and a handle arriving for a superseded attempt is ignored.
describe("MarginTutorCard — R9-6 attempt identity, delayed handles, mixed tiers", () => {
  it("a DELAYED AskHandle + delta + unmount persists a NEUTRAL interrupted cache and reopen never auto re-asks", async () => {
    setTutorEnabled(true);
    let resolveHandle: ((v: unknown) => void) | null = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "openai", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          // The dispatch happens now; the HANDLE arrives only when we say so.
          return new Promise((res) => { resolveHandle = res; });
        default:
          return Promise.resolve(null);
      }
    });
    let saved: TutorCache | undefined;
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { saved = c ?? undefined; });
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(totalAsks()).toBe(1));
    // Deltas race ahead of the handle.
    await pushDelta(lastChannel(), "streamed before the handle");

    // Unmount while the handle is STILL PENDING.
    unmount();
    expect(onCached).toHaveBeenCalledTimes(1);
    expect(saved?.interrupted).toBe(true);
    expect(saved?.brief).toContain("streamed before the handle");
    // NEUTRAL: the destination was never reported for this attempt.
    expect(saved?.briefProvider ?? null).toBeNull();

    // Reopen with that cache: replay, no second billable ask, neutral line.
    const asksBefore = totalAsks();
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: saved })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(totalAsks()).toBe(asksBefore);
    expect(screen.getByText("Your selection was sent to your AI provider.")).toBeInTheDocument();
    expect(screen.queryByText(/Answered on this Mac/i)).toBeNull();

    // The delayed handle finally resolves — it belongs to a SUPERSEDED
    // attempt and must not re-attribute the replayed answer.
    await act(async () => {
      resolveHandle?.({ ai_request_id: "late", prompt_sent: "(hidden)", provider_host: "api.openai.com" });
    });
    expect(screen.getByText("Your selection was sent to your AI provider.")).toBeInTheDocument();
    expect(screen.queryByText(/sent to OpenAI/i)).toBeNull();
  });

  it("a provider change between BRIEF and DEEP yields the ENUMERATED line — never one provider's promise (R9-6)", async () => {
    setTutorEnabled(true);
    let host = "ai.readthroughline.com"; // the brief goes through the relay
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: `ai_${host}`, prompt_sent: "(hidden)", provider_host: host });
        default:
          return Promise.resolve(null);
      }
    });
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "brief gist.");
    await pushDone(lastChannel());
    expect(
      await screen.findByText(
        "Your selection went through Throughline's relay, which does not log or store it.",
      ),
    ).toBeInTheDocument();

    // Settings changed between tiers: the deep ask reports the reader's OWN key.
    host = "api.openai.com";
    fireEvent.click(screen.getByText(/Go deeper/));
    await waitFor(() => expect(asksOfDepth("deep").length).toBe(1));
    await pushDelta(lastChannel(), "deep dive.");
    await pushDone(lastChannel());

    const line = await screen.findByText(/Parts of this answer came from different places/);
    expect(line.textContent).toContain("Throughline's relay");
    expect(line.textContent).toContain("OpenAI (your key)");
    // The relay's retention promise must NOT stretch across the BYO tier,
    // and nothing may imply on-device.
    expect(screen.queryByText(/does not log or store/i)).toBeNull();
    expect(screen.queryByText(/Answered on this Mac/i)).toBeNull();
  });

  it("a proven PRE-EGRESS refusal (NeedsCloudConsent) clears the pending state — unmount persists NO interrupted cache", async () => {
    setTutorEnabled(true);
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          // The backend refused BEFORE anything left the Mac.
          return Promise.reject({ kind: "NeedsCloudConsent", host: "ai.readthroughline.com" });
        case "cmd_outbound_envelope":
          // The REAL EnvelopePreview shape (CloudConsentSheet renders
          // envelope.selection_bounded — a flat fixture crashes the sheet).
          return Promise.resolve({
            provider: "company",
            host: "ai.readthroughline.com",
            fingerprint: "fp1",
            envelope: {
              book_title: "Meditations",
              author: null,
              chapter: null,
              selection_bounded: "the unjust man is happy",
              prompt: "FULL PROMPT TEXT",
            },
          });
        default:
          return Promise.resolve(null);
      }
    });
    const onCached = vi.fn();
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(totalAsks()).toBe(1));
    unmount();
    // Nothing was billed, so nothing is cached — a reopen may ask again
    // (with consent) instead of replaying an empty "interrupted" shell.
    expect(onCached).not.toHaveBeenCalled();
  });
});

// ── R10-4: run identity through delayed preflights + request identity ──────
describe("MarginTutorCard — R10-4 run identity, delayed preflights, request identity", () => {
  it("unmount during a DELAYED settings preflight produces ZERO asks", async () => {
    setTutorEnabled(true);
    let resolveSettings: ((v: unknown) => void) | null = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          // Both the header effect and startStream's preflight hang on this.
          return new Promise((res) => { resolveSettings = res; });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_x", prompt_sent: "(hidden)", provider_host: "localhost" });
        default:
          return Promise.resolve(null);
      }
    });
    const onCached = vi.fn();
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    // The preflight is in flight; the reader navigates away.
    unmount();
    await act(async () => {
      resolveSettings?.({ export_path: "/x", ai_provider: "openai", ai_requests_retention_days: 90 });
      await Promise.resolve();
    });
    expect(totalAsks()).toBe(0);
    // Nothing was dispatched, so nothing was cached as interrupted either.
    expect(onCached).not.toHaveBeenCalled();
  });

  it("delayed deep regenerate → delta → unmount → replay: Save is honestly disabled, and new text never carries the OLD request id", async () => {
    setTutorEnabled(true);
    let deepHandleHeld = false;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "openai", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          if ((args as { depth?: string })?.depth === "deep") {
            deepHandleHeld = true;
            return new Promise(() => {}); // the deep handle never arrives
          }
          return Promise.resolve({ ai_request_id: "ai_BRIEF", prompt_sent: "(hidden)", provider_host: "api.openai.com" });
        default:
          return Promise.resolve(null);
      }
    });
    let saved: TutorCache | undefined;
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { saved = c ?? undefined; });
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "the brief gist.");
    await pushDone(lastChannel());

    // Go deeper — its handle is DELAYED; a delta streams; the card unmounts.
    fireEvent.click(screen.getByText(/Go deeper/));
    await waitFor(() => expect(deepHandleHeld).toBe(true));
    await pushDelta(lastChannel(), "deep partial…");
    unmount();

    // The interrupted snapshot carries the deep partial with PER-TIER
    // identity (R11-6): the brief keeps ITS contributor id, while the deep
    // tier — whose handle never arrived — has none. The old single-id model
    // would have either clobbered the brief's id or misattributed the deep.
    expect(saved?.interrupted).toBe(true);
    expect(saved?.deep).toContain("deep partial");
    expect(saved?.briefRequestId).toBe("ai_BRIEF");
    expect(saved?.deepRequestId ?? null).toBeNull();

    // Replay: Save must not be silently inert — it is disabled with a reason.
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: saved })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    const save = screen.getByText(/Save as note/).closest("button")!;
    expect(save).toBeDisabled();
    expect(save.title).toMatch(/didn't finish/);
  });

  it("a LATE NeedsCloudConsent after unmount clears ITS interrupted snapshot (consent path restored) — but never a NEWER attempt's", async () => {
    setTutorEnabled(true);
    let rejectAsk: ((e: unknown) => void) | null = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return new Promise((_res, rej) => { rejectAsk = rej; });
        default:
          return Promise.resolve(null);
      }
    });
    const calls: Array<TutorCache | null> = [];
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { calls.push(c); });
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(totalAsks()).toBe(1));
    unmount();
    // The unmount persisted a (neutral) interrupted snapshot…
    expect(calls[calls.length - 1]?.interrupted).toBe(true);
    // …then the DELAYED pre-egress refusal arrives: nothing was ever sent or
    // billed, so the snapshot is CLEARED — reopening walks the consent path.
    await act(async () => { rejectAsk?.({ kind: "NeedsCloudConsent", host: "ai.readthroughline.com" }); await Promise.resolve(); });
    expect(calls[calls.length - 1]).toBeNull();

    // A NEWER attempt is never mutated by a stale outcome: new card, new
    // dispatch, then the OLD rejection fires — the newer snapshot survives.
    let rejectOld: ((e: unknown) => void) | null = null;
    rejectAsk = null;
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return new Promise((_res, rej) => {
            if (rejectOld == null) rejectOld = rej;
            else rejectAsk = rej;
          });
        default:
          return Promise.resolve(null);
      }
    });
    const calls2: Array<TutorCache | null> = [];
    const onCached2 = vi.fn((_id: string, c: TutorCache | null) => { calls2.push(c); });
    const first = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached2} />,
    );
    await waitFor(() => expect(rejectOld).not.toBeNull());
    first.unmount(); // snapshot A persisted
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached2} />,
    );
    await waitFor(() => expect(rejectAsk).not.toBeNull()); // attempt B dispatched
    const before = calls2.length;
    await act(async () => { rejectOld?.({ kind: "NeedsCloudConsent", host: "ai.readthroughline.com" }); await Promise.resolve(); });
    // The stale outcome must NOT clear anything — attempt B owns the state.
    expect(calls2.length).toBe(before);
    expect(calls2[calls2.length - 1]).not.toBeNull();
  });
});

// ── R11-6: every saved AI contributor is audited ────────────────────────────
describe("MarginTutorCard — R11-6 per-tier contributors ride with the save", () => {
  function perTierBackend() {
    let n = 0;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "openai", ai_requests_retention_days: 90 });
        case "cmd_ai_ask": {
          n += 1;
          const tier = (args as { depth?: string })?.depth;
          return Promise.resolve({ ai_request_id: `ai_${tier}_${n}`, prompt_sent: "(hidden)", provider_host: "api.openai.com" });
        }
        case "cmd_save_ai_response_as_note":
          return Promise.resolve({ note: { id: "note_1", note_type: "TutorNote" }, export: { ok: true, message: null } });
        default:
          return Promise.resolve(null);
      }
    });
  }
  function savedCall() {
    const call = mocks.invoke.mock.calls.find((c) => c[0] === "cmd_save_ai_response_as_note");
    return call?.[1] as { aiRequestId?: string; contributingRequestIds?: string[] } | undefined;
  }
  async function saveNow() {
    fireEvent.click(screen.getByText(/Save as note/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedCall()).toBeTruthy());
  }

  it("BRIEF-ONLY: the save carries the brief's id and no extra contributors", async () => {
    setTutorEnabled(true);
    perTierBackend();
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "the brief.");
    await pushDone(lastChannel());
    await saveNow();
    expect(savedCall()!.aiRequestId).toBe("ai_brief_1");
    expect(savedCall()!.contributingRequestIds).toEqual([]);
  });

  it("BRIEF+DEEP: both contributors ride with the save — the deep row is never omitted", async () => {
    setTutorEnabled(true);
    perTierBackend();
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "the brief.");
    await pushDone(lastChannel());
    fireEvent.click(screen.getByText(/Go deeper/));
    await waitFor(() => expect(asksOfDepth("deep").length).toBe(1));
    await pushDelta(lastChannel(), "the deep dive.");
    await pushDone(lastChannel());
    await saveNow();
    expect(savedCall()!.aiRequestId).toBe("ai_brief_1");
    expect(savedCall()!.contributingRequestIds).toEqual(["ai_deep_2"]);
  });

  it("FAILED DEEP: the brief's contributor survives; a later successful save carries the right ids", async () => {
    setTutorEnabled(true);
    let failDeep = true;
    let n = 0;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "openai", ai_requests_retention_days: 90 });
        case "cmd_ai_ask": {
          const tier = (args as { depth?: string })?.depth;
          if (tier === "deep" && failDeep) {
            return Promise.reject({ message: "deep blew up" });
          }
          n += 1;
          return Promise.resolve({ ai_request_id: `ai_${tier}_${n}`, prompt_sent: "(hidden)", provider_host: "api.openai.com" });
        }
        case "cmd_save_ai_response_as_note":
          return Promise.resolve({ note: { id: "note_1", note_type: "TutorNote" }, export: { ok: true, message: null } });
        default:
          return Promise.resolve(null);
      }
    });
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "the brief.");
    await pushDone(lastChannel());
    fireEvent.click(screen.getByText(/Go deeper/));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // The failed deep must not have clobbered the brief's contributor: retry
    // the deep, then save — both ids are correct.
    failDeep = false;
    fireEvent.click(screen.getByText(/Try again/));
    await waitFor(() => expect(asksOfDepth("deep").length).toBe(2));
    await pushDelta(lastChannel(), "the deep dive.");
    await pushDone(lastChannel());
    const call = mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_save_ai_response_as_note");
    expect(call).toHaveLength(0);
    fireEvent.click(screen.getByText(/Save as note/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.invoke.mock.calls.some((c) => c[0] === "cmd_save_ai_response_as_note")).toBe(true),
    );
    const saved = mocks.invoke.mock.calls.find((c) => c[0] === "cmd_save_ai_response_as_note")![1] as {
      aiRequestId: string;
      contributingRequestIds: string[];
    };
    expect(saved.aiRequestId).toBe("ai_brief_1");
    expect(saved.contributingRequestIds).toEqual(["ai_deep_2"]);
  });

  it("REGENERATE resets the tier's identity — a stale id never rides with new text", async () => {
    setTutorEnabled(true);
    perTierBackend();
    render(card());
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "first answer.");
    await pushDone(lastChannel());
    // Regenerate: a NEW brief ask with a NEW id.
    fireEvent.click(screen.getByLabelText("Regenerate answer"));
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(2));
    await pushDelta(lastChannel(), "second answer.");
    await pushDone(lastChannel());
    await saveNow();
    expect(savedCall()!.aiRequestId).toBe("ai_brief_2");
    expect(savedCall()!.contributingRequestIds).toEqual([]);
  });
});

// ── R11-5: CapExhausted is POST-egress for the tutor too ────────────────────
describe("MarginTutorCard — R11-5 CapExhausted is a terminal, persisted state", () => {
  it("dispatch → unmount → delayed CapExhausted → remount: exactly one send, cap doors shown, no silent re-ask", async () => {
    setTutorEnabled(true);
    let rejectAsk: ((e: unknown) => void) | null = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return new Promise((_res, rej) => { rejectAsk = rej; });
        default:
          return Promise.resolve(null);
      }
    });
    const calls: Array<TutorCache | null> = [];
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { calls.push(c); });
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(totalAsks()).toBe(1));
    unmount();
    // The 402 lands late — POST-egress: the snapshot upgrades to the
    // terminal cap state instead of being cleared.
    await act(async () => { rejectAsk?.({ kind: "CapExhausted" }); await Promise.resolve(); });
    const latest = calls[calls.length - 1];
    expect(latest, "the snapshot is UPGRADED, never cleared").not.toBeNull();
    expect(latest!.capExhausted).toBe(true);
    expect(latest!.interrupted).toBe(true);

    // Remount with that cache: the cap doors render, and no ask fires.
    const asksBefore = totalAsks();
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: latest! })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(totalAsks(), "no silent re-send after a post-egress 402").toBe(asksBefore);
    expect(screen.getByText(/You've used the generous tutoring/i)).toBeInTheDocument();
  });

  it("a MOUNTED CapExhausted persists the same terminal state (unmount/remount stays quiet)", async () => {
    setTutorEnabled(true);
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          return Promise.reject({ kind: "CapExhausted" });
        default:
          return Promise.resolve(null);
      }
    });
    let saved: TutorCache | undefined;
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { saved = c ?? undefined; });
    const { unmount } = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(screen.getByText(/You've used the generous tutoring/i)).toBeInTheDocument());
    expect(saved?.capExhausted).toBe(true);
    unmount();
    const asksBefore = totalAsks();
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: saved })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(totalAsks()).toBe(asksBefore);
    expect(screen.getByText(/You've used the generous tutoring/i)).toBeInTheDocument();
  });
});

// ── R11 closure: the terminal cap state survives REPEATED replay ────────────
describe("MarginTutorCard — R11 closure: capExhausted survives the done-replay cache rewrite", () => {
  it("brief done + deep 402 → remount → remount: capExhausted stays true, cap doors stay, zero extra asks", async () => {
    setTutorEnabled(true);
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ export_path: "/x", ai_provider: "company", ai_requests_retention_days: 90 });
        case "cmd_ai_ask":
          if ((args as { depth?: string })?.depth === "deep") {
            return Promise.reject({ kind: "CapExhausted" });
          }
          return Promise.resolve({ ai_request_id: "ai_brief_1", prompt_sent: "(hidden)", provider_host: "ai.readthroughline.com" });
        default:
          return Promise.resolve(null);
      }
    });
    const caches: Array<TutorCache | null> = [];
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { caches.push(c); });

    // A BRIEF answer succeeds and settles into the cache…
    const first = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(1));
    await pushDelta(lastChannel(), "the settled brief answer.");
    await pushDone(lastChannel());
    await waitFor(() => expect(caches.length).toBeGreaterThan(0));

    // …then the DEEP tier hits the cap (post-egress terminal state).
    fireEvent.click(screen.getByText(/Go deeper/));
    await waitFor(() => expect(screen.getByText(/You've used the generous tutoring/i)).toBeInTheDocument());
    const terminal = caches[caches.length - 1]!;
    expect(terminal.capExhausted).toBe(true);
    expect(terminal.brief).toContain("the settled brief answer");
    first.unmount();
    const asksAfterCap = totalAsks();

    // FIRST reopen with the terminal cache: the done-replay effect rewrites
    // the cache — the terminal flag must ride along.
    const second = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: terminal })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/You've used the generous tutoring/i)).toBeInTheDocument();
    const replayEmitted = caches[caches.length - 1]!;
    expect(
      replayEmitted.capExhausted,
      "the replay/cache-sync effect must PRESERVE the terminal cap state",
    ).toBe(true);
    second.unmount();

    // SECOND reopen with the cache the replay effect emitted.
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: replayEmitted })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(
      screen.getByText(/You've used the generous tutoring/i),
      "the cap doors survive the second reopen",
    ).toBeInTheDocument();
    expect((caches[caches.length - 1] ?? replayEmitted).capExhausted).toBe(true);
    expect(totalAsks(), "no additional cmd_ai_ask across either reopen").toBe(asksAfterCap);
  });
});

// ── R11 final closure: cap → "Keep going free" recovers cleanly ─────────────
describe("MarginTutorCard — R11 final closure: the setup path out of the cap screen clears the terminal state", () => {
  it("CapExhausted → real AiSetupSheet connect → replacement answer replaces the cap doors, cache is clean, replay stays clean", async () => {
    setTutorEnabled(true);
    // Company hits the cap; after the reader connects a BYO key, asks succeed.
    let provider = "company";
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({
            export_path: "/x",
            ai_provider: provider,
            ai_requests_retention_days: 90,
            ai_codex_creds_present: false,
          });
        case "cmd_ai_ask":
          if (provider === "company") return Promise.reject({ kind: "CapExhausted" });
          return Promise.resolve({ ai_request_id: "ai_byo_1", prompt_sent: "(hidden)", provider_host: "api.openai.com" });
        case "cmd_test_ai_connection":
          return Promise.resolve({ reachable: true, first_model_id: "gpt", message: "ok" });
        case "cmd_set_ai_key":
          return Promise.resolve({});
        case "cmd_set_ai_settings":
          provider = "openai"; // the sheet's connect persists the new provider
          return Promise.resolve({});
        default:
          return Promise.resolve(null);
      }
    });
    const caches: Array<TutorCache | null> = [];
    const onCached = vi.fn((_id: string, c: TutorCache | null) => { caches.push(c); });

    const first = render(
      <MarginTutorCard bookId="bk1" draft={baseDraft()} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    // The company request reaches CapExhausted → the cap doors.
    await waitFor(() => expect(screen.getByText(/You've used the generous tutoring/i)).toBeInTheDocument());

    // "Keep going free": the REAL AiSetupSheet paste-key route.
    fireEvent.click(screen.getByText(/Paste API key & ask/i));
    fireEvent.change(await screen.findByLabelText(/OpenAI API key/i), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText(/Verify & answer/i));

    // The replacement request fires on the connected provider and succeeds.
    await waitFor(() => expect(asksOfDepth("brief").length).toBe(2));
    await pushDelta(lastChannel(), "the BYO answer.");
    await pushDone(lastChannel());

    // The cap doors are gone; the answer is visible.
    await waitFor(() => expect(screen.getByText(/the BYO answer\./)).toBeInTheDocument());
    expect(screen.queryByText(/You've used the generous tutoring/i)).toBeNull();
    // The emitted cache is CLEAN.
    const settled = caches[caches.length - 1]!;
    expect(settled.capExhausted).toBeFalsy();
    expect(settled.brief).toContain("the BYO answer");
    first.unmount();

    // Replay with that cache: answer visible, no cap doors, no extra ask.
    const asksBefore = totalAsks();
    render(
      <MarginTutorCard bookId="bk1" draft={baseDraft({ cache: settled })} active onActivate={() => {}} onSaved={() => {}} onDiscard={() => {}} onCached={onCached} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/the BYO answer\./)).toBeInTheDocument();
    expect(screen.queryByText(/You've used the generous tutoring/i)).toBeNull();
    expect(totalAsks()).toBe(asksBefore);
  });
});

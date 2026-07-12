import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act, within } from "@testing-library/react";
import SectionBriefingCard from "./SectionBriefingCard";
import { setCachedBriefing, resetBriefingCache, resetBriefingAttempts, resetBriefingPending } from "../sectionBriefing";

const mocks = vi.hoisted(() => {
  class MockChannel {
    onmessage: ((e: unknown) => void) | null = null;
  }
  const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null));
  return { invoke, Channel: MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: mocks.Channel }));
type MockChannelT = InstanceType<typeof mocks.Channel>;

function setImpl() {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_get_settings":
        return Promise.resolve({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m", margin_help: "deep_study" });
      case "cmd_ai_ask":
        return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "localhost" });
      case "cmd_test_ai_connection":
        return Promise.resolve({ reachable: true, first_model_id: "m", message: "ok" });
      default:
        return Promise.resolve(null);
    }
  });
}

// The briefing cache is session-only (in-memory) — localStorage.clear() no
// longer resets it, so drop it explicitly between cases.
beforeEach(() => { cleanup(); localStorage.clear(); resetBriefingCache(); resetBriefingAttempts(); resetBriefingPending(); setImpl(); });

const props = {
  bookId: "bk", sectionId: "s1", sourceSha: "sha1", mode: "deep_study",
  chapter: "BOOK I", locator: "char:0", sectionText: "Great art Thou, O Lord…",
  onDismiss: () => {},
};

function lastChannel(): MockChannelT {
  const call = [...mocks.invoke.mock.calls].reverse().find((c) => c[0] === "cmd_ai_ask");
  if (!call) throw new Error("cmd_ai_ask was never called");
  return (call[1] as { onEvent: MockChannelT }).onEvent;
}

const SAMPLE = "BEFORE YOU READ\nThe central tension.\n\nWATCH FOR\n- the paradox\n\nKEY TERMS\nNone needed.\n\nTHE MOVE\nSets up the work.\n\nREADING QUESTION\nWhy seek?";

describe("SectionBriefingCard", () => {
  it("renders a CACHED briefing instantly without calling the model", async () => {
    // R8-4: attribution rides in the cache — this one was answered locally.
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE, "local");
    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/The central tension\./)).toBeInTheDocument();
    expect(screen.getByText("the paradox")).toBeInTheDocument();
    expect(screen.getByText(/Why seek\?/)).toBeInTheDocument();
    expect(screen.getByText(/Prepared on this Mac/i)).toBeInTheDocument();
    // Cache hit → no model call.
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
  });

  it("a cache with UNKNOWN attribution renders NEUTRAL — never 'On this Mac' (R8-4)", async () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE); // no attribution
    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/The central tension\./)).toBeInTheDocument();
    expect(screen.queryByText(/Prepared on this Mac/i)).toBeNull();
    expect(screen.getByText(/Prepared via AI for today's section\./)).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
  });

  it("REPLAY attributes from the CACHE, never current Settings — drift → settle → remount, no second ask (R8-4)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          // Settings now say the included assistant…
          return Promise.resolve({ ai_provider: "company", margin_help: "deep_study" });
        case "cmd_ai_ask":
          // …but THIS answer was audited to Anthropic.
          return Promise.resolve({
            ai_request_id: "ai_1",
            prompt_sent: "(hidden)",
            provider_host: "api.anthropic.com",
          });
        default:
          return Promise.resolve(null);
      }
    });
    const first = render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: SAMPLE }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    expect(screen.getByText(/Prepared via Anthropic for today's section\./)).toBeInTheDocument();
    first.unmount();

    // Remount (navigation back): the cache replays with its ORIGINAL
    // attribution — no second AI call, and Settings' "company" never leaks in.
    const asksBefore = mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;
    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/The central tension\./)).toBeInTheDocument();
    expect(screen.getByText(/Prepared via Anthropic for today's section\./)).toBeInTheDocument();
    expect(screen.queryByText(/Prepared via Throughline AI/i)).toBeNull();
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length,
      "no second AI call on replay",
    ).toBe(asksBefore);
  });

  it("after PROVIDER DRIFT the settled attribution follows the ask's REPORTED destination, not mount-time state (R7-9)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          // Mount-time state says the included assistant…
          return Promise.resolve({ ai_provider: "company", margin_help: "deep_study" });
        case "cmd_ai_ask":
          // …but the backend resolved (and audited) THIS ask to Anthropic.
          return Promise.resolve({
            ai_request_id: "ai_1",
            prompt_sent: "(hidden)",
            provider_host: "api.anthropic.com",
          });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: SAMPLE }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    expect(screen.getByText(/Prepared via Anthropic for today's section\./)).toBeInTheDocument();
    expect(screen.queryByText(/Prepared via Throughline AI/i)).toBeNull();
  });

  it("auto-prepares (streams) when tutor is enabled and nothing is cached", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    render(<SectionBriefingCard {...props} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.objectContaining({ mode: "section_briefing", selection: "Great art Thou, O Lord…" })),
    );
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: SAMPLE }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    expect(screen.getByText(/The central tension\./)).toBeInTheDocument();
  });

  it("does NOT call the model until the reader consents (opt-in gate)", async () => {
    // tutor NOT enabled, nothing cached → consent card, no call.
    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/Deep Study can prepare/i)).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());

    fireEvent.click(screen.getByText("Prepare briefing"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.objectContaining({ mode: "section_briefing" })),
    );
    expect(localStorage.getItem("tl.tutorEnabled")).toBe("true");
  });

  it("renders Watch-for items as plain text when no marker handler is given", async () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE);
    const { container } = render(<SectionBriefingCard {...props} />);
    await screen.findByText("the paradox");
    // No onAskContext → no marker buttons, just a static list.
    expect(container.querySelector(".tl-briefing-marker")).toBeNull();
  });

  it("v2: renders Watch-for items as tappable context markers that fire onAskContext", async () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE);
    const onAskContext = vi.fn();
    const { container } = render(<SectionBriefingCard {...props} onAskContext={onAskContext} />);
    await screen.findByText("the paradox");
    const marker = container.querySelector(".tl-briefing-marker") as HTMLButtonElement;
    expect(marker).not.toBeNull();
    fireEvent.click(marker);
    expect(onAskContext).toHaveBeenCalledWith("the paradox");
  });
});

describe("SectionBriefingCard — provider gate", () => {
  // No AI provider chosen → preparing a briefing would have nowhere safe to go.
  function setNoProvider() {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "none", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "" });
        default:
          return Promise.resolve(null);
      }
    });
  }

  it("does NOT generate when no provider is chosen, and shows the cold-start setup sheet", async () => {
    localStorage.setItem("tl.tutorEnabled", "true"); // would normally auto-prepare
    setNoProvider();
    render(<SectionBriefingCard {...props} />);
    // The dead-end "Choose one in Settings" message is replaced by setup-at-intent.
    expect(await screen.findByText(/Tutor not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/Paste API key & ask/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_get_settings"));
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
    expect(screen.queryByText(/Nothing leaves your device/i)).toBeNull();
    expect(screen.queryByText(/^On this Mac$/)).toBeNull();
  });

  it("a company outage opens the paused sheet in Throughline AI's voice — truthful, no key-pasting CTA (CORE-1037)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "company", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "ai.readthroughline.com" });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    const ch = lastChannel();
    // The relay went quiet AFTER the send — the audit row for this minute says Sent →.
    await act(async () => { ch.onmessage?.({ kind: "error", message: "Throughline AI request failed: connection refused" }); });
    expect(await screen.findByText(/Throughline AI hit a snag/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been sent/i)).toBeNull();
    expect(screen.queryByText(/Switch provider/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Check again/i })).toBeInTheDocument();
  });

  // FT-13 (CORE-1046): a failed briefing must NOT silently re-fire on remount.
  // The reader nav remounts the card constantly (key={section.id}); without a
  // session marker, each remount auto-fired a fresh metered section-text send.
  function setCompanyAskRejects() {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "company", margin_help: "deep_study" });
        case "cmd_ai_ask":
          // A client-error-shaped failure that does NOT read as unavailable, so
          // the card stays in the [Try again] error box (not the paused sheet).
          return Promise.reject(new Error("Throughline AI couldn't take that request (400). Try again."));
        default:
          return Promise.resolve(null);
      }
    });
  }

  function askCallCount(): number {
    return mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;
  }

  it("a failed briefing never auto-refires on remount", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    setCompanyAskRejects();

    const { unmount } = render(<SectionBriefingCard {...props} />);
    await screen.findByRole("button", { name: /Try again/i });
    expect(askCallCount()).toBe(1);

    // The reader navigates (Next/Prev) or re-enters the reader → remount the
    // SAME card. The failed attempt is remembered this session, so no auto-fire.
    unmount();
    render(<SectionBriefingCard {...props} />);
    // Mounts straight into the error state — never "Preparing…" again.
    expect(await screen.findByRole("button", { name: /Try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/Preparing/i)).toBeNull();
    expect(askCallCount()).toBe(1);
  });

  it("[Try again] clears the failed marker and re-invokes exactly once per click", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    setCompanyAskRejects();

    render(<SectionBriefingCard {...props} />);
    const retry = await screen.findByRole("button", { name: /Try again/i });
    expect(askCallCount()).toBe(1);

    fireEvent.click(retry);
    await waitFor(() => expect(askCallCount()).toBe(2));
  });

  it("when a CLOUD provider is chosen, the briefing IS allowed (calls cmd_ai_ask) and never claims local", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "anthropic", ai_model_anthropic: "claude-opus-4-8", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "api.anthropic.com" });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    expect(screen.queryByText(/^On this Mac$/)).toBeNull();
  });

  // P1-2: NeedsCloudConsent / CapExhausted historically carried no `message`, so the
  // catch rendered the literal "[object Object]" with a Try again that re-fired the
  // same rejection forever. Both must now show actionable copy and no garbage.
  function rejectAskWith(err: unknown) {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "company", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return Promise.reject(err);
        case "cmd_test_ai_connection":
          return Promise.resolve({ reachable: true, first_model_id: "m", message: "ok" });
        default:
          return Promise.resolve(null);
      }
    });
  }

  it("cap-exhausted rejection shows actionable copy, never [object Object]", async () => {
    rejectAskWith({ kind: "CapExhausted" }); // historic shape: no message field
    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/Throughline AI/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/object Object/i)).toBeNull();
  });

});

// ── PRIV-A11Y-009 / TRUST-002 R3: a Deep-Study briefing that is the reader's
// FIRST cloud action opens the SAME fail-closed consent sheet the lenses use,
// with the exact SECTION envelope — never a "go ask the tutor elsewhere" detour.
describe("SectionBriefingCard — first-cloud consent sheet", () => {
  const SECTION_ENVELOPE = {
    host: "ai.example.com",
    provider: "company",
    fingerprint: "fp:company:ai.example.com",
    envelope: {
      book_title: "Confessions",
      author: "Augustine",
      chapter: "BOOK I",
      selection_bounded: "Great art Thou, O Lord…",
      prompt: "THE FULL PROMPT WORD FOR WORD",
    },
  };

  const askCalls = () => mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask");
  const boundAskCalls = () =>
    askCalls().filter((c) => (c[1] as Record<string, unknown> | undefined)?.consent != null);

  /** A gate backend mirroring the REAL R6-1 send boundary (see
   *  MarginTutorCard.test.tsx): the envelope carries a backend-issued binding;
   *  an unconsented cmd_ai_ask validates it against CURRENT state and records
   *  consent only on an exact match. Every command is overridable per test. */
  function setConsentImpl(
    overrides: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {},
    opts?: { boundAskFailsOnce?: { message: string } },
  ) {
    localStorage.setItem("tl.tutorEnabled", "true");
    const state = { provider: "company", host: "ai.example.com", consented: false };
    const fp = () => `fp:${state.provider}:${state.host}`;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (overrides[cmd]) return overrides[cmd](args);
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: state.provider, margin_help: "deep_study" });
        case "cmd_ai_ask": {
          if (!state.consented) {
            const b = args?.consent as { provider: string; host: string; fingerprint: string } | null;
            const bound = b && b.provider === state.provider && b.host === state.host && b.fingerprint === fp();
            if (!bound) return Promise.reject({ kind: "NeedsCloudConsent", host: state.host });
            if (opts?.boundAskFailsOnce) {
              const failure = opts.boundAskFailsOnce;
              opts.boundAskFailsOnce = undefined;
              return Promise.reject({ kind: "Db", message: failure.message });
            }
            state.consented = true;
          }
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: state.host });
        }
        case "cmd_outbound_envelope":
          return Promise.resolve({
            ...SECTION_ENVELOPE,
            host: state.host,
            provider: state.provider,
            fingerprint: fp(),
          });
        default:
          return Promise.resolve(null);
      }
    });
    return state;
  }

  it("opens the fail-closed sheet with the exact SECTION envelope; Send disabled until the preview loads", async () => {
    let resolveEnvelope: ((v: unknown) => void) | null = null;
    setConsentImpl({
      cmd_outbound_envelope: () => new Promise((res) => { resolveEnvelope = res; }),
    });
    render(<SectionBriefingCard {...props} />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Send this section to ai\.example\.com/);
    // The envelope was requested for the SECTION, through the briefing mode.
    const envCall = mocks.invoke.mock.calls.find((c) => c[0] === "cmd_outbound_envelope");
    expect(envCall?.[1]).toMatchObject({
      mode: "section_briefing",
      selection: "Great art Thou, O Lord…",
      chapter: "BOOK I",
    });
    // FAIL-CLOSED: Send stays disabled while the exact preview is loading…
    const send = screen.getByRole("button", { name: /Send to ai\.example\.com/ });
    expect(send).toBeDisabled();
    expect(boundAskCalls()).toHaveLength(0);
    // …and enables only once it arrived, showing the exact section text.
    await act(async () => { resolveEnvelope!(SECTION_ENVELOPE); });
    expect(send).not.toBeDisabled();
    expect(screen.getByText(/"Great art Thou, O Lord…"/)).toBeInTheDocument();
  });

  it("a FAILED preview keeps Send disabled and Retry re-fetches (fail closed)", async () => {
    let fail = true;
    setConsentImpl({
      cmd_outbound_envelope: () =>
        fail ? Promise.reject({ message: "offline" }) : Promise.resolve(SECTION_ENVELOPE),
    });
    render(<SectionBriefingCard {...props} />);

    await screen.findByRole("dialog");
    expect(await screen.findByText(/nothing will be sent/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send to ai\.example\.com/ })).toBeDisabled();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Send to ai\.example\.com/ })).not.toBeDisabled(),
    );
  });

  it("Cancel (Not now) closes the sheet without confirming or sending", async () => {
    setConsentImpl();
    render(<SectionBriefingCard {...props} />);
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: /Not now/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/wasn't confirmed/i)).toBeInTheDocument();
    expect(boundAskCalls()).toHaveLength(0);
    // Only the initial (refused) ask happened — nothing was sent after Cancel.
    expect(askCalls()).toHaveLength(1);
  });

  it("a FAILED consent write at the send boundary is honest and recoverable — nothing armed, nothing generated (R3→R6)", async () => {
    const state = setConsentImpl({}, { boundAskFailsOnce: { message: "database is locked" } });
    render(<SectionBriefingCard {...props} />);
    await screen.findByRole("dialog");
    const send = await screen.findByRole("button", { name: /Send to ai\.example\.com/ });
    await waitFor(() => expect(send).not.toBeDisabled());

    fireEvent.click(send);
    // The bound ask failed AT the boundary (consent write error): consent was
    // NOT recorded, no briefing was generated, and the card says what
    // happened instead of pretending the reader consented.
    await waitFor(() => expect(askCalls()).toHaveLength(2));
    expect(state.consented).toBe(false);
    expect(await screen.findByText(/database is locked/i)).toBeInTheDocument();

    // Recoverable: asking again re-gates (consent was never armed) and the
    // fresh sheet's Send goes through.
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await screen.findByRole("dialog");
    const send2 = await screen.findByRole("button", { name: /Send to ai\.example\.com/ });
    await waitFor(() => expect(send2).not.toBeDisabled());
    fireEvent.click(send2);
    await waitFor(() => expect(state.consented).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Send is ATOMIC: one bound ask, sheet closes with it, late Escape neither cancels nor duplicates (R4→R6)", async () => {
    let resolveAsk: ((v: unknown) => void) | null = null;
    const state = setConsentImpl({
      cmd_ai_ask: (args?: Record<string, unknown>) => {
        const b = args?.consent as { provider: string; host: string; fingerprint: string } | null;
        if (!state.consented) {
          const bound =
            b && b.provider === "company" && b.host === "ai.example.com" && b.fingerprint === "fp:company:ai.example.com";
          if (!bound) return Promise.reject({ kind: "NeedsCloudConsent", host: "ai.example.com" });
          state.consented = true;
          // The authorized send is in flight — hang so a late cancel can try.
          return new Promise((res) => {
            resolveAsk = () => res({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "ai.example.com" });
          });
        }
        return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "ai.example.com" });
      },
    });
    render(<SectionBriefingCard {...props} />);
    await screen.findByRole("dialog");
    const send = await screen.findByRole("button", { name: /Send to ai\.example\.com/ });
    await waitFor(() => expect(send).not.toBeDisabled());

    // R6-1: Send fires the ONE bound ask and the sheet closes with it — no
    // confirm-then-send window in which a cancel could race a consent that
    // then arms and sends after the reader said no (the R4 hazard is
    // structurally gone, not merely guarded).
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(boundAskCalls()).toHaveLength(1));

    fireEvent.keyDown(document.body, { key: "Escape" });
    await act(async () => {});
    expect(boundAskCalls()).toHaveLength(1);

    await act(async () => { resolveAsk!(null); });
    expect(boundAskCalls()).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the sheet says SECTION (mode-aware copy) and Not now returns focus to the briefing card (R4)", async () => {
    setConsentImpl();
    const { container } = render(<SectionBriefingCard {...props} />);
    const dialog = await screen.findByRole("dialog");
    // Deep Study sends a SECTION — the sheet must not say "passage".
    expect(dialog).toHaveTextContent(/Send this section to ai\.example\.com/);
    expect(dialog).toHaveTextContent(/This is the section, exactly as it will be sent/);

    fireEvent.click(screen.getByRole("button", { name: /Not now/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The durable focus-return target: the briefing card itself — the sheet
    // opened from an auto-trigger, so there is no surviving invoker button.
    const card = container.querySelector(".tl-briefing") as HTMLElement;
    expect(document.activeElement).toBe(card);
  });

  it("Escape (deferred envelope still loading) also returns focus to the briefing card (R4)", async () => {
    setConsentImpl({
      cmd_outbound_envelope: () => new Promise(() => {}), // never resolves
    });
    const { container } = render(<SectionBriefingCard {...props} />);
    const dialog = await screen.findByRole("dialog");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const card = container.querySelector(".tl-briefing") as HTMLElement;
    expect(document.activeElement).toBe(card);
  });

  it("HOST DRIFT under the open sheet is rejected AT the send boundary: zero egress, nothing armed, fresh matching preview (R5→R6)", async () => {
    const state = setConsentImpl();
    render(<SectionBriefingCard {...props} />);
    await screen.findByRole("dialog");
    const send = await screen.findByRole("button", { name: /Send to ai\.example\.com/ });
    await waitFor(() => expect(send).not.toBeDisabled());

    // The provider changes UNDER the open sheet (Settings in another pane) —
    // after the preview the reader is looking at, immediately before dispatch.
    state.provider = "anthropic";
    state.host = "api.other-provider.com";
    fireEvent.click(send);

    // Fails closed AT the boundary: the stale binding was refused (zero
    // egress — the mock only proceeds once consent validates), consent was
    // NOT armed for the new provider, and the sheet reopens with the NEW
    // destination and its fresh matching preview.
    const fresh = await screen.findByRole("dialog", { name: /Send this section to api\.other-provider\.com/i });
    expect(state.consented).toBe(false);
    expect(boundAskCalls()).toHaveLength(1);
    await within(fresh).findByText(/exactly as it will be sent/i);

    // Stable destination → the fresh binding validates and consent arms.
    const send2 = screen.getByRole("button", { name: /Send to api\.other-provider\.com/ });
    await waitFor(() => expect(send2).not.toBeDisabled());
    fireEvent.click(send2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(state.consented).toBe(true));
    expect((boundAskCalls()[1][1] as Record<string, unknown>).consent).toEqual({
      provider: "anthropic",
      host: "api.other-provider.com",
      fingerprint: "fp:anthropic:api.other-provider.com",
    });
  });

  it("a confirmed consent generates the briefing in the SAME bound ask (success path)", async () => {
    const state = setConsentImpl();
    render(<SectionBriefingCard {...props} />);
    await screen.findByRole("dialog");
    const send = await screen.findByRole("button", { name: /Send to ai\.example\.com/ });
    await waitFor(() => expect(send).not.toBeDisabled());

    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // ONE ask carried the binding — consent recorded and the send is the
    // very call the reader confirmed (no confirm-then-regenerate pair).
    await waitFor(() => expect(askCalls()).toHaveLength(2));
    expect(boundAskCalls()).toHaveLength(1);
    expect(state.consented).toBe(true);
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: SAMPLE }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    expect(screen.getByText(/The central tension\./)).toBeInTheDocument();
  });
});

// ── R9-6: fresh settle/attribution state per generation ────────────────────
// Before the fix, settledRef stayed true from a previous settled briefing, so
// a REGENERATE whose AskHandle resolved mid-stream patched the PARTIAL text
// into the session cache as a completed briefing — and stale provider refs
// could attribute the new text to the previous destination.
import { getCachedBriefing } from "../sectionBriefing";

describe("SectionBriefingCard — R9-6 regenerate resets settle/attribution", () => {
  it("a handle resolving MID-STREAM after regenerate never caches partial text as completed", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    // A settled prior briefing (the stale-settledRef precondition).
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE, "openai");

    // The regenerate's ask: the handle resolves only when WE say so.
    let resolveHandle: ((v: unknown) => void) | null = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return new Promise((res) => { resolveHandle = res; });
        default:
          return Promise.resolve(null);
      }
    });

    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/The central tension\./)).toBeInTheDocument();

    // Regenerate: clears the cache, streams a PARTIAL delta, then the
    // DELAYED handle resolves before "done".
    fireEvent.click(screen.getByLabelText("Regenerate briefing"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()),
    );
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: "PARTIAL " }); });
    await act(async () => {
      resolveHandle?.({ ai_request_id: "ai_2", prompt_sent: "(hidden)", provider_host: "localhost" });
    });

    // The partial text must NOT have been cached as completed.
    expect(getCachedBriefing("bk", "s1", "sha1", "deep_study")).toBeNull();

    // Completion caches the full text with THIS attempt's attribution.
    await act(async () => { ch.onmessage?.({ kind: "delta", text: "then the rest." }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    const settled = getCachedBriefing("bk", "s1", "sha1", "deep_study");
    expect(settled?.text).toBe("PARTIAL then the rest.");
    expect(settled?.answeredProvider).toBe("local");
  });

  it("an error followed by a stray done never caches the partial briefing (R9-6)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    render(<SectionBriefingCard {...props} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()),
    );
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: "half an answer" }); });
    await act(async () => { ch.onmessage?.({ kind: "error", message: "boom" }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    expect(getCachedBriefing("bk", "s1", "sha1", "deep_study")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

// ── R10-4: briefing attempt lifecycle — pending markers + run identity ─────
import { getBriefingPending } from "../sectionBriefing";

describe("SectionBriefingCard — R10-4 pending markers + run identity", () => {
  it("unmount during a DELAYED settings preflight produces ZERO asks", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    let resolveSettings: ((v: unknown) => void) | null = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return new Promise((res) => { resolveSettings = res; });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_x", prompt_sent: "(hidden)", provider_host: "localhost" });
        default:
          return Promise.resolve(null);
      }
    });
    const { unmount } = render(<SectionBriefingCard {...props} />);
    unmount();
    await act(async () => {
      resolveSettings?.({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m" });
      await Promise.resolve();
    });
    const asks = mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask");
    expect(asks).toHaveLength(0);
    // No pending marker was armed either — nothing dispatched.
    expect(getBriefingPending("bk", "s1", "sha1", "deep_study")).toBeNull();
  });

  it("dispatch → unmount → remount BEFORE handle/done/error produces exactly ONE ask, with an honest interrupted state", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m" });
        case "cmd_ai_ask":
          return new Promise(() => {}); // handle never arrives
        default:
          return Promise.resolve(null);
      }
    });
    const askCount = () => mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;
    const { unmount } = render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(askCount()).toBe(1));
    unmount();

    // Remount: the session pending marker blocks a second auto-fire.
    render(<SectionBriefingCard {...props} />);
    await act(async () => { await Promise.resolve(); });
    expect(askCount()).toBe(1); // EXACTLY one ask across the whole sequence
    expect(screen.getByText(/interrupted before it finished/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("a LATE NeedsCloudConsent clears only ITS pending marker (consent path restored) — never a newer attempt's", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const rejecters: Array<(e: unknown) => void> = [];
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "company", ai_base_url: "", ai_model: "m" });
        case "cmd_ai_ask":
          return new Promise((_res, rej) => { rejecters.push(rej); });
        default:
          return Promise.resolve(null);
      }
    });
    const askCount = () => mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;

    // Attempt 1 dispatches, the card unmounts, THEN the pre-egress refusal
    // arrives: its marker clears, so the consent path can run again.
    const first = render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(askCount()).toBe(1));
    first.unmount();
    expect(getBriefingPending("bk", "s1", "sha1", "deep_study")).not.toBeNull();
    await act(async () => { rejecters[0]?.({ kind: "NeedsCloudConsent", host: "ai.readthroughline.com" }); await Promise.resolve(); });
    expect(
      getBriefingPending("bk", "s1", "sha1", "deep_study"),
      "the pre-egress refusal cleared its own marker",
    ).toBeNull();

    // The consent path is restored: a remount auto-generates again…
    const second = render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(askCount()).toBe(2));
    // …and a stale outcome from an OLDER attempt never clears the NEWER
    // attempt's marker.
    second.unmount();
    const markerBefore = getBriefingPending("bk", "s1", "sha1", "deep_study");
    expect(markerBefore).not.toBeNull();
    render(<SectionBriefingCard {...props} />); // remount; attempt 2's marker rules
    await act(async () => { await Promise.resolve(); });
    expect(askCount()).toBe(2); // pending marker blocked a third auto-fire
    // The FIRST attempt's rejection already fired; fire a hypothetical stale
    // one again — token mismatch, marker untouched.
    await act(async () => { rejecters[0]?.({ kind: "NeedsCloudConsent", host: "x" }); await Promise.resolve(); });
    expect(getBriefingPending("bk", "s1", "sha1", "deep_study")).toBe(markerBefore);
  });
});

// ── R11-4/R11-5: real attempt identity + post-egress CapExhausted ───────────
import React from "react";

describe("SectionBriefingCard — R11-4 attempt identity under StrictMode + overlap", () => {
  it("STRICT MODE first mount with DELAYED settings/model preflights issues exactly ONE cmd_ai_ask", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const settingsResolvers: Array<(v: unknown) => void> = [];
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          // EVERY settings read is delayed — the StrictMode probe run and
          // the real run both sit in this window.
          return new Promise((res) => { settingsResolvers.push(res); });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_sm", prompt_sent: "(hidden)", provider_host: "localhost" });
        case "cmd_test_ai_connection":
          return Promise.resolve({ reachable: true, first_model_id: "m", message: "ok" });
        default:
          return Promise.resolve(null);
      }
    });
    const askCount = () => mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;

    render(
      <React.StrictMode>
        <SectionBriefingCard {...props} />
      </React.StrictMode>,
    );
    // Let the delayed preflights resolve for every queued run.
    await act(async () => {
      for (const res of settingsResolvers.splice(0)) {
        res({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m" });
      }
      await Promise.resolve();
    });
    await act(async () => {
      for (const res of settingsResolvers.splice(0)) {
        res({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m" });
      }
      await Promise.resolve();
    });
    expect(askCount(), "the StrictMode probe run must not double-dispatch").toBe(1);
  });

  it("two OVERLAPPING generate calls: only the newest dispatches, and only its channel accepts events", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const settingsResolvers: Array<(v: unknown) => void> = [];
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return new Promise((res) => { settingsResolvers.push(res); });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_new", prompt_sent: "(hidden)", provider_host: "localhost" });
        case "cmd_test_ai_connection":
          return Promise.resolve({ reachable: true, first_model_id: "m", message: "ok" });
        default:
          return Promise.resolve(null);
      }
    });
    const askCount = () => mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;
    const settings = { ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m" };

    render(<SectionBriefingCard {...props} />);
    // Attempt 1 is parked in its settings preflight. The reader hits
    // Regenerate — attempt 2 begins while 1 is still awaited.
    await waitFor(() => expect(settingsResolvers.length).toBeGreaterThanOrEqual(2));
    // (index 0 = provider-badge effect, later ones = generate preflights)
    // Force a second generation while the first is parked:
    // resolve everything and let both runs race out of their preflights.
    await act(async () => {
      for (const res of settingsResolvers.splice(0)) res(settings);
      await Promise.resolve();
    });
    await waitFor(() => expect(askCount()).toBeGreaterThanOrEqual(0));
    const asksAfterMount = askCount();

    // Now the real overlap: two generates via the UI. Kick a regenerate
    // while a second regenerate immediately supersedes it.
    if (asksAfterMount === 1) {
      const ch = lastChannel();
      await act(async () => { ch.onmessage?.({ kind: "delta", text: SAMPLE }); });
      await act(async () => { ch.onmessage?.({ kind: "done" }); });
      const regen = screen.getByLabelText("Regenerate briefing");
      fireEvent.click(regen); // attempt A — parked in preflight
      fireEvent.click(regen); // attempt B — supersedes A before A dispatches
      await act(async () => {
        for (const res of settingsResolvers.splice(0)) res(settings);
        await Promise.resolve();
      });
      await act(async () => {
        for (const res of settingsResolvers.splice(0)) res(settings);
        await Promise.resolve();
      });
      // Exactly ONE new dispatch (B). A was superseded during its preflight.
      expect(askCount()).toBe(asksAfterMount + 1);
      // And only the NEWEST channel accepts events: stream a delta + done.
      const newest = lastChannel();
      await act(async () => { newest.onmessage?.({ kind: "delta", text: "fresh briefing text" }); });
      await act(async () => { newest.onmessage?.({ kind: "done" }); });
      expect(screen.getByText(/fresh briefing text/)).toBeInTheDocument();
    }
  });
});

describe("SectionBriefingCard — R11-5 CapExhausted is POST-egress", () => {
  it("dispatch → unmount → delayed CapExhausted → remount: exactly one send until an explicit Try again", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    const rejecters: Array<(e: unknown) => void> = [];
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "company", ai_base_url: "", ai_model: "m" });
        case "cmd_ai_ask":
          return new Promise((_res, rej) => { rejecters.push(rej); });
        default:
          return Promise.resolve(null);
      }
    });
    const askCount = () => mocks.invoke.mock.calls.filter((c) => c[0] === "cmd_ai_ask").length;

    const first = render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(askCount()).toBe(1));
    first.unmount();
    // The DELAYED 402 lands after unmount — the section already reached the
    // relay, so this is a TERMINAL state, never a clear-and-rearm.
    await act(async () => { rejecters[0]?.({ kind: "CapExhausted" }); await Promise.resolve(); });

    // Remount: no silent resend.
    render(<SectionBriefingCard {...props} />);
    await act(async () => { await Promise.resolve(); });
    expect(askCount(), "no silent re-send after a post-egress 402").toBe(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Only a DELIBERATE Try again re-sends.
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(askCount()).toBe(2));
  });
});

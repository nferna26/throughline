import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import Settings from "./Settings";
import type { SettingsDto, CompanyCredits, AiRequest } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

// UpdateChecker calls getVersion via @tauri-apps/api/app — keep it inert.
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.4.2") }));

function wire(
  dto: Partial<SettingsDto>,
  opts: { credits?: CompanyCredits | null; requests?: AiRequest[] } = {},
) {
  const full: SettingsDto = {
    export_path: "/Users/x/Documents/Reading",
    export_path_is_default: true,
    app_data_path: "/Users/x/Library/Application Support/Throughline",
    ai_posture: "Local-only mode: ON",
    ai_base_url: "http://localhost:1234/v1",
    ai_model: "m",
    quote_policy: "Short quotes only.",
    quote_warn_chars: 300,
    ai_requests_retention_days: 90,
    margin_help: "guided",
    ai_provider: "company",
    ai_provider_chosen: true,
    ai_remote_allowed: true,
    ai_model_openai: "gpt-5.5",
    ai_model_anthropic: "claude-opus-4-8",
    ai_model_codex: "gpt-5.5",
    ai_key_present_openai: false,
    ai_key_present_anthropic: false,
    ai_codex_creds_present: false,
    ai_phrases: true,
    ...dto,
  };
  const credits: CompanyCredits | null =
    opts.credits === undefined
      ? { status: "active", remaining_fraction: 0.74, approx_questions_left: 220 }
      : opts.credits;
  const requests = opts.requests ?? [];
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_get_settings": return Promise.resolve(full);
      case "cmd_company_credits": return Promise.resolve(credits);
      case "cmd_company_status": return Promise.resolve({ provider_active: full.ai_provider === "company", has_license: true });
      case "cmd_list_ai_models": return Promise.resolve(["m"]);
      case "cmd_list_ai_requests": return Promise.resolve(requests);
      case "cmd_model_catalog": return Promise.resolve([]);
      case "cmd_test_ai_connection": return Promise.resolve({ reachable: true, first_model_id: "m", message: "Connected." });
      default: return Promise.resolve(undefined);
    }
  });
}

beforeEach(() => mockInvoke.mockReset());

describe("Settings — 4-section redesign", () => {
  it("opens to the calm paid-primary statement (no setup), not a config dump", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByText(/Answers come from Throughline's included assistant/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/No setup — it just works/i)).toBeInTheDocument();
    // The four section eyebrows, in order.
    expect(screen.getByText("Reading assistant")).toBeInTheDocument();
    expect(screen.getByText("Privacy")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
  });

  // FT-11: the allowance meter must read the REAL remaining_fraction, not a constant.
  it("renders the allowance meter from cmd_company_credits (real fraction, not hardcoded)", async () => {
    wire({ ai_provider: "company" }, { credits: { status: "active", remaining_fraction: 0.42, approx_questions_left: 120 } });
    render(<Settings />);
    const meter = await screen.findByRole("progressbar", { name: /Reading help remaining/i });
    expect(meter).toHaveAttribute("aria-valuenow", "42");
    const fill = meter.querySelector(".meter-fill") as HTMLElement;
    expect(fill.style.width).toBe("42%");
    // Calm state word + accent (not warn) while there is plenty.
    expect(screen.getByText("Plenty left")).toBeInTheDocument();
    expect(screen.queryByText("Running low")).toBeNull();
  });

  it("switches the meter to a warn 'Running low' state only when genuinely low", async () => {
    wire({ ai_provider: "company" }, { credits: { status: "active", remaining_fraction: 0.08, approx_questions_left: 12 } });
    render(<Settings />);
    expect(await screen.findByText("Running low")).toBeInTheDocument();
    expect(screen.queryByText("Plenty left")).toBeNull();
    // The low state pairs the warn color with a word + recolors via the `.low` class.
    const meter = screen.getByRole("progressbar", { name: /Reading help remaining/i });
    expect(meter.closest(".allowance")).toHaveClass("low");
  });

  it("shows no meter and no dollars/tokens/percent-jargon in company mode copy", async () => {
    wire({ ai_provider: "company" });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText(/No setup — it just works/i)).toBeInTheDocument());
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/endpoint/i);
  });

  // FT-24: in company mode the key/local controls are hidden until the reader
  // opens "Use your own AI instead".
  it("hides the key and local controls until the fallback expander is opened", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Use your own AI instead/i)).toBeInTheDocument());
    // Collapsed: the segmented fallback modes are not interactive-visible yet.
    expect(screen.queryByRole("group", { name: /Use your own AI/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Your own key/i })).toBeNull();
    // Open the expander…
    fireEvent.click(screen.getByText(/Use your own AI instead/i));
    expect(await screen.findByRole("group", { name: /Use your own AI/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Your own key/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /On this Mac only/i })).toBeInTheDocument();
  });

  // Regression: selecting a fallback segment must REVEAL its controls without
  // switching the active assistant — a curious click can't silently break the
  // working paid assistant. Nothing persists until the explicit "Use this".
  it("selecting a fallback reveals controls but does not switch providers until 'Use this'", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Use your own AI instead/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Use your own AI instead/i));
    await screen.findByRole("group", { name: /Use your own AI/i });

    mockInvoke.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Your own key/i }));
    // The key field reveals…
    expect(await screen.findByLabelText(/Anthropic key/i)).toBeInTheDocument();
    // …but nothing was saved: no provider switch on a mere segment click.
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_set_ai_settings", expect.anything());
    // "Use this" is disabled while no key is entered or saved (can't commit a
    // provider that wouldn't answer).
    const useThis = screen.getByRole("button", { name: /Use this/i });
    expect(useThis).toBeDisabled();

    // Type a key → committable → clicking "Use this" persists the key + provider.
    fireEvent.change(screen.getByLabelText(/Anthropic key/i), { target: { value: "sk-ant-xyz" } });
    expect(screen.getByRole("button", { name: /Use this/i })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Use this/i }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_set_ai_key", { provider: "anthropic", key: "sk-ant-xyz" }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("cmd_set_ai_settings", expect.objectContaining({ provider: "anthropic" }));
  });

  it("starts the fallback expander open and shows the key field when already on a BYO provider", async () => {
    wire({ ai_provider: "anthropic", ai_key_present_anthropic: true });
    render(<Settings />);
    // No meter for BYO mode.
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    // Key field visible (the one place "key" is allowed).
    expect(await screen.findByLabelText(/Anthropic key/i)).toBeInTheDocument();
    // The model row explains pricing in plain words.
    expect(screen.getByText(/the going rate for heavier vs\. lighter models/i)).toBeInTheDocument();
  });

  it("warns (warn color) when on your own key but none is set — a genuine warning", async () => {
    wire({ ai_provider: "openai", ai_key_present_openai: false });
    render(<Settings />);
    expect(await screen.findByText(/Add a key to start answering/i)).toBeInTheDocument();
  });

  // FT-12: the audit shows plain lens names, grouped, with no hostname / no raw
  // internal id / no alarm-orange, collapsed by default, retention + Forget kept.
  it("reframes the audit: plain lens label, no hostname, no raw 'section_briefing' id", async () => {
    const requests: AiRequest[] = [
      { id: "1", book_id: "b1", book_title: "The Yellow Wallpaper", mode: "section_briefing", locator: null, context_char_count: null, provider: "ai.readthroughline.com", created_at: "2026-06-10T09:48:00Z", wrote_to_memory: false },
      { id: "2", book_id: "b1", book_title: "The Yellow Wallpaper", mode: "explain", locator: null, context_char_count: null, provider: "ai.readthroughline.com", created_at: "2026-06-09T10:13:00Z", wrote_to_memory: true },
    ];
    wire({ ai_provider: "company" }, { requests });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText(/What's left this Mac/i)).toBeInTheDocument());
    // Collapsed by default: a real <details> whose body isn't open.
    const details = container.querySelector("details.audit") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    // Expand it.
    fireEvent.click(screen.getByText(/Show what was sent/i));
    // Plain lens labels — NEVER the raw id.
    expect(screen.getByText("Section briefing")).toBeInTheDocument();
    expect(screen.getByText("Explain")).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/section_briefing/);
    // No hostname / upstream service name anywhere.
    expect(text).not.toMatch(/ai\.readthroughline\.com/);
    expect(text).not.toMatch(/readthroughline/i);
    // Grouped by book with a calm "Sent to assistant", never an alarm host arrow.
    expect(screen.getByText(/The Yellow Wallpaper/)).toBeInTheDocument();
    expect(screen.getAllByText(/Sent to assistant/).length).toBeGreaterThan(0);
    // No row carries the alarm/warn color class on a normal "sent" state (FT-23).
    expect(container.querySelector(".log-row .tl-audit-tag.sent")).toBeNull();
  });

  it("keeps retention + Forget now in the audit, collapsed and calm", async () => {
    const requests: AiRequest[] = [
      { id: "1", book_id: "b1", book_title: "Meditations", mode: "explain", locator: null, context_char_count: null, provider: "x", created_at: "2026-06-10T09:48:00Z", wrote_to_memory: false },
    ];
    wire({ ai_provider: "company", ai_requests_retention_days: 90 }, { requests });
    render(<Settings />);
    fireEvent.click(await screen.findByText(/Show what was sent/i));
    expect(screen.getByText(/Keep this list for/i)).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Forget now/i })).toBeInTheDocument();
  });

  it("shows a calm empty audit state when nothing has been sent", async () => {
    wire({ ai_provider: "company" }, { requests: [] });
    const { container } = render(<Settings />);
    fireEvent.click(await screen.findByText(/Show what was sent/i));
    const empty = container.querySelector(".audit-empty") as HTMLElement;
    expect(empty).toBeTruthy();
    expect(empty.textContent).toMatch(/Nothing has been sent\./i);
  });

  // FT-21: one coherent calm trust statement, per mode, never an alarm.
  it("keeps the privacy trust statement and an active-mode note", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Everything stays on this Mac/i)).toBeInTheDocument());
    expect(screen.getByText(/Book files stay here — never uploaded\./i)).toBeInTheDocument();
    expect(screen.getByText(/An answer becomes a note only when you save it\./i)).toBeInTheDocument();
    // Active-mode note names the included assistant calmly.
    expect(screen.getByText(/you're using the/i)).toBeInTheDocument();
  });

  it("the active-mode note affirms nothing is sent in On this Mac only", async () => {
    wire({ ai_provider: "local" });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Everything stays on this Mac/i)).toBeInTheDocument());
    const note = container.querySelector(".trust-mode") as HTMLElement;
    expect(note.textContent).toMatch(/nothing is sent/i);
    expect(note.textContent).toMatch(/On this Mac only/i);
  });

  // FT-35: the read-only filesystem path is gone; replaced by a calm action /
  // plain line that the library stays on this Mac — without printing the path.
  it("does not print the library filesystem path, and shows the export folder by name", async () => {
    wire({ ai_provider: "company", export_path: "/Users/x/Documents/Reading", app_data_path: "/Users/x/Library/Application Support/Throughline" });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText("Files")).toBeInTheDocument());
    const text = container.textContent ?? "";
    // No raw application-support path anywhere on screen.
    expect(text).not.toMatch(/Library\/Application Support/);
    expect(text).not.toMatch(/Local storage path/i);
    // The export chip shows the folder's display name, not the full path.
    expect(screen.getByText("Reading")).toBeInTheDocument();
    expect(text).not.toMatch(/\/Users\/x\/Documents\/Reading/);
    // The library line stays reassuring without a path.
    expect(
      screen.getByText(/Your books live on this Mac and stay here, backed up automatically/i),
    ).toBeInTheDocument();
  });

  // FT-36: the fair-use legalese card → one plain line + a short-quote note.
  // The note is always on and not toggleable, so it reads as a plain
  // informational line, never a dead on+disabled switch.
  it("reduces quoting to one plain line with a short-quote note", async () => {
    wire({ ai_provider: "company", quote_warn_chars: 300 });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText("Quoting")).toBeInTheDocument());
    expect(screen.getByText(/keeps quotes short, for private study/i)).toBeInTheDocument();
    expect(screen.getByText(/about 300 characters — never a block/i)).toBeInTheDocument();

    // The control is an "Always on" informational line — not a switch.
    const quotingRow = screen.getByText("Quoting").closest(".row") as HTMLElement;
    expect(quotingRow).not.toBeNull();
    expect(within(quotingRow).getByText(/Always on/i)).toBeInTheDocument();
    expect(within(quotingRow).queryByRole("switch")).toBeNull();
  });

  // FT: no reader-visible plumbing words / hostnames on the screen.
  it("uses plain words only — no tokens / endpoint / API / hostnames on screen", async () => {
    const requests: AiRequest[] = [
      { id: "1", book_id: "b1", book_title: "The Odyssey", mode: "section_briefing", locator: null, context_char_count: null, provider: "ai.readthroughline.com", created_at: "2026-06-10T07:48:00Z", wrote_to_memory: false },
    ];
    wire({ ai_provider: "company" }, { requests });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText(/No setup — it just works/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Use your own AI instead/i));
    fireEvent.click(screen.getByText(/Show what was sent/i));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/endpoint/i);
    // "API" must not appear (the lone allowed word is "key", which we use).
    expect(text).not.toMatch(/\bAPI\b/);
    expect(text).not.toMatch(/readthroughline/i);
    expect(text).not.toMatch(/localhost(?!:\d)/); // a typed default placeholder is fine; no bare host prose
  });

  // FT-06 honest-copy carryover: the tutor toggle never claims a local answer
  // while a cloud assistant is live, and the active-mode note tells the truth.
  it("never claims everything stays local while the included (cloud) assistant is live", async () => {
    wire({ ai_provider: "company" });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Everything stays on this Mac/i)).toBeInTheDocument());
    const text = container.textContent ?? "";
    // The trust statement is precise: books stay; only the selected passage is sent.
    expect(screen.getByText(/only that one passage is sent to get an answer/i)).toBeInTheDocument();
    // It does NOT falsely say answers are computed locally in company mode.
    expect(text).not.toMatch(/run on a local model/i);
  });

  it("the included-assistant active note steers to On this Mac only, calmly (no orange)", async () => {
    wire({ ai_provider: "company" });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Everything stays on this Mac/i)).toBeInTheDocument());
    const note = container.querySelector(".trust-mode") as HTMLElement;
    expect(note).toBeTruthy();
    expect(within(note).getByText(/included assistant/i)).toBeInTheDocument();
    // It is the calm muted note, not a warn card.
    expect(note.className).not.toMatch(/warn|alert/);
  });

  // Export your library: a deliberate reader action that writes one Markdown
  // file per book, then confirms in plain words with the count + folder name.
  it("exports the library and confirms with the book count and folder name", async () => {
    wire({ ai_provider: "company", export_path: "/Users/x/Documents/Reading" });
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({
            export_path: "/Users/x/Documents/Reading",
            export_path_is_default: true,
            app_data_path: "/Users/x/Library/Application Support/Throughline",
            ai_posture: "Local-only mode: ON",
            ai_base_url: "http://localhost:1234/v1",
            ai_model: "m",
            quote_policy: "Short quotes only.",
            quote_warn_chars: 300,
            ai_requests_retention_days: 90,
            margin_help: "guided",
            ai_provider: "company",
            ai_provider_chosen: true,
            ai_remote_allowed: true,
            ai_model_openai: "gpt-5.5",
            ai_model_anthropic: "claude-opus-4-8",
            ai_model_codex: "gpt-5.5",
            ai_key_present_openai: false,
            ai_key_present_anthropic: false,
            ai_codex_creds_present: false,
          } as SettingsDto);
        case "cmd_company_credits":
          return Promise.resolve({ status: "active", remaining_fraction: 0.74, approx_questions_left: 220 });
        case "cmd_list_ai_requests":
          return Promise.resolve([]);
        case "cmd_export_library":
          return Promise.resolve({ exported: 3, root: "/Users/x/Documents/Reading" });
        default:
          return Promise.resolve(undefined);
      }
    });
    render(<Settings />);
    const btn = await screen.findByRole("button", { name: /Export your library/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_export_library"),
    );
    // Calm confirmation: the count + the folder name, never a raw path.
    const msg = await screen.findByText(/Exported 3 books to your Reading folder\./i);
    expect(msg).toBeInTheDocument();
    expect(msg.textContent).not.toMatch(/\/Users\/x\/Documents\/Reading/);
  });

  it("singularizes the export confirmation for a single book", async () => {
    wire({ ai_provider: "company", export_path: "/Users/x/Documents/Reading" });
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({
            export_path: "/Users/x/Documents/Reading",
            export_path_is_default: true,
            app_data_path: "/Users/x/Library/Application Support/Throughline",
            ai_posture: "Local-only mode: ON",
            ai_base_url: "http://localhost:1234/v1",
            ai_model: "m",
            quote_policy: "Short quotes only.",
            quote_warn_chars: 300,
            ai_requests_retention_days: 90,
            margin_help: "guided",
            ai_provider: "company",
            ai_provider_chosen: true,
            ai_remote_allowed: true,
            ai_model_openai: "gpt-5.5",
            ai_model_anthropic: "claude-opus-4-8",
            ai_model_codex: "gpt-5.5",
            ai_key_present_openai: false,
            ai_key_present_anthropic: false,
            ai_codex_creds_present: false,
          } as SettingsDto);
        case "cmd_company_credits":
          return Promise.resolve({ status: "active", remaining_fraction: 0.74, approx_questions_left: 220 });
        case "cmd_list_ai_requests":
          return Promise.resolve([]);
        case "cmd_export_library":
          return Promise.resolve({ exported: 1, root: "/Users/x/Documents/Reading" });
        default:
          return Promise.resolve(undefined);
      }
    });
    render(<Settings />);
    fireEvent.click(await screen.findByRole("button", { name: /Export your library/i }));
    expect(await screen.findByText(/Exported 1 book to your Reading folder\./i)).toBeInTheDocument();
  });

  it("shows a calm, blame-free message when the library export fails", async () => {
    wire({ ai_provider: "company", export_path: "/Users/x/Documents/Reading" });
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({
            export_path: "/Users/x/Documents/Reading",
            export_path_is_default: true,
            app_data_path: "/Users/x/Library/Application Support/Throughline",
            ai_posture: "Local-only mode: ON",
            ai_base_url: "http://localhost:1234/v1",
            ai_model: "m",
            quote_policy: "Short quotes only.",
            quote_warn_chars: 300,
            ai_requests_retention_days: 90,
            margin_help: "guided",
            ai_provider: "company",
            ai_provider_chosen: true,
            ai_remote_allowed: true,
            ai_model_openai: "gpt-5.5",
            ai_model_anthropic: "claude-opus-4-8",
            ai_model_codex: "gpt-5.5",
            ai_key_present_openai: false,
            ai_key_present_anthropic: false,
            ai_codex_creds_present: false,
          } as SettingsDto);
        case "cmd_company_credits":
          return Promise.resolve({ status: "active", remaining_fraction: 0.74, approx_questions_left: 220 });
        case "cmd_list_ai_requests":
          return Promise.resolve([]);
        case "cmd_export_library":
          return Promise.reject(new Error("The export folder is read-only."));
        default:
          return Promise.resolve(undefined);
      }
    });
    const { container } = render(<Settings />);
    fireEvent.click(await screen.findByRole("button", { name: /Export your library/i }));
    const err = await screen.findByText(/Couldn't export your library/i);
    expect(err).toBeInTheDocument();
    // Says what happened and what to do; reassures the books are unchanged.
    expect(err.textContent).toMatch(/read-only/i);
    expect(err.textContent).toMatch(/Your books are unchanged/i);
    expect(err).toHaveClass("err");
    // No raw stack/jargon dump beyond the human reason.
    expect(container.querySelector(".set-msg.err")).toBeTruthy();
  });

  // The Files section reassures that the library is backed up automatically on
  // this Mac — paired with the calm "kept on this Mac" copy, no plumbing words.
  it("reassures the library is backed up automatically on this Mac (calm, no jargon)", async () => {
    wire({ ai_provider: "company" });
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByText("Files")).toBeInTheDocument());
    expect(screen.getByText(/backed up automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/Kept on this Mac/i)).toBeInTheDocument();
    const text = container.textContent ?? "";
    // No plumbing words in the backup reassurance.
    expect(text).not.toMatch(/\bsync\b/i);
    expect(text).not.toMatch(/cloud/i);
  });

  // ── Stage 3: session names (AI phrases) + the rebuilt company surface ──

  it("session-names toggle round-trips aiPhrases through cmd_set_ai_settings", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    const toggle = await screen.findByRole("switch", { name: "Session names" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    await waitFor(() => {
      const call = mockInvoke.mock.calls.find(
        (c) => c[0] === "cmd_set_ai_settings" && (c[1] as { aiPhrases?: boolean })?.aiPhrases !== undefined,
      );
      expect(call).toBeTruthy();
      expect((call![1] as { aiPhrases: boolean }).aiPhrases).toBe(false);
    });
  });

  it("company mode shows the active status and usage as approximate questions", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText("Throughline AI is active.")).toBeInTheDocument());
    expect(screen.getByText("About 220 questions left.")).toBeInTheDocument();
    // Reader language only: questions, never tokens or dollars.
    expect(screen.queryByText(/token|\$\d/i)).toBeNull();
  });

  it("without a license, Settings offers the activation-code door and activates", async () => {
    wire({ ai_provider: "company" }, { credits: null });
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings": return Promise.resolve({
          export_path: "/x", export_path_is_default: true, app_data_path: "/a",
          ai_posture: "p", ai_base_url: "http://localhost:1234/v1", ai_model: "m",
          quote_policy: "q", quote_warn_chars: 300, ai_requests_retention_days: 90,
          margin_help: "guided", ai_provider: "company", ai_provider_chosen: true,
          ai_remote_allowed: true, ai_model_openai: "", ai_model_anthropic: "",
          ai_model_codex: "", ai_key_present_openai: false, ai_key_present_anthropic: false,
          ai_codex_creds_present: false, ai_phrases: true,
        });
        case "cmd_company_status": return Promise.resolve({ provider_active: true, has_license: false });
        case "cmd_company_credits": return Promise.reject({ kind: "Config", message: "not activated" });
        case "cmd_list_ai_requests": return Promise.resolve([]);
        case "cmd_activate_company": return Promise.resolve({ provider_active: true, has_license: true });
        default: return Promise.resolve(undefined);
      }
    });
    render(<Settings />);
    const input = await screen.findByLabelText("Activation code");
    fireEvent.change(input, { target: { value: "ABCD-1234-EFGH" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_activate_company", { activationToken: "ABCD-1234-EFGH" }),
    );
  });
});

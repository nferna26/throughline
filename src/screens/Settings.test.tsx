import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import Settings, { fmtBackupWhen } from "./Settings";
import type { SettingsDto, CompanyCredits, AiRequest, BackupEntry, BackupStatus } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The Software Update pane pulls in the update machine; mock its plugins (the
// real plugin-updater extends api/core's Resource at import time).
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

function fullDto(dto: Partial<SettingsDto>): SettingsDto {
  return {
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
    ui_theme: "light",
    reading_typeface: "newsreader",
    reading_line_spacing: "comfortable",
    ...dto,
  };
}

function wire(
  dto: Partial<SettingsDto>,
  opts: {
    credits?: CompanyCredits | null;
    requests?: AiRequest[];
    backup?: BackupStatus;
    backups?: BackupEntry[];
  } = {},
) {
  const full = fullDto(dto);
  const credits: CompanyCredits | null =
    opts.credits === undefined
      ? { status: "active", remaining_fraction: 0.74, approx_questions_left: 220 }
      : opts.credits;
  const requests = opts.requests ?? [];
  const backup = opts.backup ?? { enabled: true, last_backup_at: "2026-07-08T09:12:00-07:00" };
  const backups = opts.backups ?? [];
  mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
    switch (cmd) {
      case "cmd_get_settings": return Promise.resolve(full);
      case "cmd_set_appearance": return Promise.resolve({ ...full, ...(args as object) });
      case "cmd_company_credits": return Promise.resolve(credits);
      case "cmd_company_status": return Promise.resolve({ provider_active: full.ai_provider === "company", has_license: true });
      case "cmd_list_ai_models": return Promise.resolve(["m"]);
      case "cmd_list_ai_requests": return Promise.resolve(requests);
      case "cmd_model_catalog": return Promise.resolve([]);
      case "cmd_test_ai_connection": return Promise.resolve({ reachable: true, first_model_id: "m", message: "Connected." });
      case "cmd_get_reading_pace": return Promise.resolve({ minutes: 25, chosen: false });
      case "cmd_feedback_diagnostics": return Promise.resolve({ app_version: "0.8.4", macos_version: "15.5", mode: "included" });
      case "cmd_backup_status": return Promise.resolve(backup);
      case "cmd_set_backups_enabled": return Promise.resolve({ ...backup, enabled: (args as { enabled: boolean }).enabled });
      case "cmd_list_backups": return Promise.resolve(backups);
      case "cmd_restore_backup": return Promise.resolve(undefined);
      default: return Promise.resolve(undefined);
    }
  });
}

/** The rail is always on screen; this opens one of its destinations. */
async function openPane(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

beforeEach(() => {
  mockInvoke.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute("data-typeface");
  document.documentElement.removeAttribute("data-linespacing");
});

/* ═══════════════ Rail + frame ═══════════════ */

describe("Settings — left rail", () => {
  it("renders the rail destinations in order, with Send feedback below the divider", async () => {
    wire({});
    const { container } = render(<Settings />);
    const nav = await screen.findByRole("navigation", { name: /settings sections/i });
    const items = Array.from(nav.querySelectorAll("button.set-rail-item")).map((b) => b.textContent);
    expect(items).toEqual([
      "Reading", "Appearance", "Assistant", "Privacy", "Files", "Shortcuts", "Software Update", "Send feedback",
    ]);
    // The divider sits between Shortcuts and Send feedback.
    expect(container.querySelector(".set-rail-divider")).toBeTruthy();
    // Rail footer keeps the promise lines.
    expect(screen.getByText(/No accounts\. No tracking\./)).toBeInTheDocument();
    expect(screen.getByText(/Your reading is yours\./)).toBeInTheDocument();
  });

  it("shows a quiet version line in the rail footer (the About decision)", async () => {
    wire({});
    render(<Settings />);
    expect(await screen.findByText("Throughline 0.8.4")).toBeInTheDocument();
  });

  it("opens to Reading, and clicking a rail item switches the pane", async () => {
    wire({});
    render(<Settings />);
    expect(await screen.findByRole("heading", { name: "Reading" })).toBeInTheDocument();
    await openPane("Appearance");
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reading" })).toBeNull();
  });

  it("rail is arrow-key navigable (ArrowDown/ArrowUp move focus through the items)", async () => {
    wire({});
    render(<Settings />);
    const nav = await screen.findByRole("navigation", { name: /settings sections/i });
    const items = Array.from(nav.querySelectorAll<HTMLButtonElement>("button.set-rail-item"));
    items[0].focus();
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(nav, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    // ArrowUp from the top wraps to the last item (Send feedback).
    fireEvent.keyDown(nav, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(nav, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("marks the active destination with aria-current", async () => {
    wire({});
    render(<Settings />);
    const reading = await screen.findByRole("button", { name: "Reading" });
    expect(reading).toHaveAttribute("aria-current", "page");
    await openPane("Privacy");
    expect(screen.getByRole("button", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
    expect(reading).not.toHaveAttribute("aria-current");
  });
});

/* ═══════════════ Reading pane ═══════════════ */

describe("Reading pane", () => {
  it("round-trips the sitting size through cmd_set_reading_pace", async () => {
    wire({});
    render(<Settings />);
    const sel = await screen.findByLabelText("Reading pace");
    await waitFor(() => expect(sel).toBeEnabled());
    fireEvent.change(sel, { target: { value: "10" } });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_set_reading_pace", { minutes: 10 }),
    );
  });

  it("shows Quoting as a plain always-on line — never a switch (counsel posture)", async () => {
    wire({});
    render(<Settings />);
    const label = await screen.findByText("Quoting");
    const row = label.closest(".set-row") as HTMLElement;
    expect(within(row).getByText("Always on")).toBeInTheDocument();
    expect(within(row).queryByRole("switch")).toBeNull();
  });
});

/* ═══════════════ Appearance pane ═══════════════ */

describe("Appearance pane", () => {
  it("theme is a segmented Light/Dark/Auto that persists through cmd_set_appearance", async () => {
    wire({ ui_theme: "light" });
    render(<Settings />);
    await openPane("Appearance");
    const seg = await screen.findByRole("group", { name: "Theme" });
    const auto = within(seg).getByRole("button", { name: "Auto" });
    // The stored (backend) theme wins once settings load.
    await waitFor(() =>
      expect(within(seg).getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true"),
    );
    fireEvent.click(auto);
    expect(auto).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_set_appearance", { theme: "auto" }),
    );
    // The boot-cache mirror keeps the first frame flash-free after relaunch.
    expect(localStorage.getItem("tl.themePref")).toBe("auto");
  });

  it("typeface persists and applies to the reading view live (data-typeface)", async () => {
    wire({});
    render(<Settings />);
    await openPane("Appearance");
    fireEvent.change(await screen.findByLabelText("Typeface"), { target: { value: "charter" } });
    expect(document.documentElement.dataset.typeface).toBe("charter");
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_set_appearance", { typeface: "charter" }),
    );
  });

  it("line spacing persists and applies live (data-linespacing)", async () => {
    wire({});
    render(<Settings />);
    await openPane("Appearance");
    fireEvent.change(await screen.findByLabelText("Line spacing"), { target: { value: "open" } });
    expect(document.documentElement.dataset.linespacing).toBe("open");
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_set_appearance", { lineSpacing: "open" }),
    );
  });

  it("the text-size stepper nudges the shared tl.fontSize pref and shows pt", async () => {
    wire({});
    render(<Settings />);
    await openPane("Appearance");
    expect(await screen.findByText("18 pt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(screen.getByText("19 pt")).toBeInTheDocument();
    expect(localStorage.getItem("tl.fontSize")).toBe("19");
    fireEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    expect(screen.getByText("18 pt")).toBeInTheDocument();
    expect(localStorage.getItem("tl.fontSize")).toBe("18");
  });
});

/* ═══════════════ Assistant pane ═══════════════ */

describe("Assistant pane", () => {
  it("keeps the tutor and session-names switches, keyboard-operable role=switch", async () => {
    wire({});
    render(<Settings />);
    await openPane("Assistant");
    const tutor = await screen.findByRole("switch", { name: "Tutor in the margin" });
    const names = screen.getByRole("switch", { name: "Session names" });
    expect(tutor.tagName).toBe("BUTTON"); // native button = Enter/Space operable
    expect(names).toHaveAttribute("aria-checked", "true");
  });

  it("session-names toggle round-trips aiPhrases through cmd_set_ai_settings", async () => {
    wire({});
    render(<Settings />);
    await openPane("Assistant");
    const toggle = await screen.findByRole("switch", { name: "Session names" });
    fireEvent.click(toggle);
    await waitFor(() => {
      const call = mockInvoke.mock.calls.find(
        (c) => c[0] === "cmd_set_ai_settings" && (c[1] as { aiPhrases?: boolean })?.aiPhrases !== undefined,
      );
      expect(call).toBeTruthy();
      expect((call![1] as { aiPhrases: boolean }).aiPhrases).toBe(false);
    });
  });

  it("shows a calm qualitative Included-tutoring status — no bar, no number, no percent", async () => {
    wire({ ai_provider: "company" }, { credits: { status: "active", remaining_fraction: 0.42, approx_questions_left: 120 } });
    const { container } = render(<Settings />);
    await openPane("Assistant");
    expect(await screen.findByText("Included tutoring")).toBeInTheDocument();
    expect(screen.getByText("On · plenty remaining")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector(".meter, .meter-fill")).toBeNull();
    const pane = container.querySelector(".set-pane")?.textContent ?? "";
    expect(pane).not.toMatch(/120/);
    expect(pane).not.toMatch(/%/);
  });

  it("reads 'Running low' (still no numbers) only when genuinely low", async () => {
    wire({ ai_provider: "company" }, { credits: { status: "active", remaining_fraction: 0.08, approx_questions_left: 12 } });
    const { container } = render(<Settings />);
    await openPane("Assistant");
    expect(await screen.findByText("Running low")).toBeInTheDocument();
    expect(
      screen.getByText(/keeps working with your own API key or a local model, free/i),
    ).toBeInTheDocument();
    const pane = container.querySelector(".set-pane")?.textContent ?? "";
    expect(pane).not.toMatch(/\b12\b/);
    expect(pane).not.toMatch(/%/);
  });

  it("selecting a fallback in 'Answers come from' opens setup and switches NOTHING until 'Use this'", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    await openPane("Assistant");
    const source = await screen.findByLabelText("Answers come from");
    mockInvoke.mockClear();
    fireEvent.change(source, { target: { value: "own_key" } });
    // The deep setup opens as a sheet; the key field reveals…
    const sheet = await screen.findByRole("dialog", { name: "Answers come from" });
    expect(within(sheet).getByLabelText(/Anthropic key/i)).toBeInTheDocument();
    // …but nothing was saved: no provider switch on a mere selection.
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_set_ai_settings", expect.anything());
    // "Use this" is disabled while no key is entered or saved.
    const useThis = within(sheet).getByRole("button", { name: "Use this" });
    expect(useThis).toBeDisabled();
    // Type a key → committable → "Use this" persists key + provider.
    fireEvent.change(within(sheet).getByLabelText(/Anthropic key/i), { target: { value: "sk-ant-xyz" } });
    expect(within(sheet).getByRole("button", { name: "Use this" })).toBeEnabled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Use this" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_set_ai_key", { provider: "anthropic", key: "sk-ant-xyz" }),
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "cmd_set_ai_settings",
      expect.objectContaining({ provider: "anthropic" }),
    );
  });

  it("cancelling the setup sheet snaps the select back to the committed mode", async () => {
    wire({ ai_provider: "company" });
    render(<Settings />);
    await openPane("Assistant");
    const source = await screen.findByLabelText("Answers come from");
    fireEvent.change(source, { target: { value: "local" } });
    const sheet = await screen.findByRole("dialog", { name: "Answers come from" });
    expect(within(sheet).getByLabelText("Server address")).toBeInTheDocument();
    // Escape closes without committing; the select shows the real mode again.
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByLabelText("Answers come from") as HTMLSelectElement).value).toBe("included");
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "cmd_set_ai_settings",
      expect.objectContaining({ provider: "local" }),
    );
  });

  it("switching to Throughline AI commits directly (it is zero-setup)", async () => {
    wire({ ai_provider: "anthropic", ai_key_present_anthropic: true });
    render(<Settings />);
    await openPane("Assistant");
    const source = await screen.findByLabelText("Answers come from");
    await waitFor(() => expect((source as HTMLSelectElement).value).toBe("own_key"));
    fireEvent.change(source, { target: { value: "included" } });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "cmd_set_ai_settings",
        expect.objectContaining({ provider: "company" }),
      ),
    );
  });

  it("offers 'Set up' on the row when already on a fallback, opening the sheet seeded to it", async () => {
    wire({ ai_provider: "local" });
    render(<Settings />);
    await openPane("Assistant");
    fireEvent.click(await screen.findByRole("button", { name: "Set up" }));
    const sheet = await screen.findByRole("dialog", { name: "Answers come from" });
    expect(within(sheet).getByLabelText("Server address")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Back to included assistant/i })).toBeInTheDocument();
  });

  it("without a license, the Assistant pane offers the activation-code door and activates", async () => {
    wire({ ai_provider: "company" }, { credits: null });
    const base = fullDto({ ai_provider: "company" });
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings": return Promise.resolve(base);
        case "cmd_company_status": return Promise.resolve({ provider_active: true, has_license: false });
        case "cmd_company_credits": return Promise.reject({ kind: "Config", message: "not activated" });
        case "cmd_list_ai_requests": return Promise.resolve([]);
        case "cmd_activate_company": return Promise.resolve({ provider_active: true, has_license: true });
        case "cmd_get_reading_pace": return Promise.resolve({ minutes: 25, chosen: true });
        case "cmd_backup_status": return Promise.resolve({ enabled: true, last_backup_at: null });
        default: return Promise.resolve(undefined);
      }
    });
    render(<Settings />);
    await openPane("Assistant");
    const input = await screen.findByLabelText("Activation code");
    expect(input).toHaveAttribute("placeholder", "XXXX-XXXX-XXXX");
    fireEvent.change(input, { target: { value: "ABCD-1234-EFGH" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_activate_company", { activationToken: "ABCD-1234-EFGH" }),
    );
  });
});

/* ═══════════════ Privacy pane ═══════════════ */

describe("Privacy pane", () => {
  it("leads with the local promise and the accent Always", async () => {
    wire({});
    render(<Settings />);
    await openPane("Privacy");
    expect(await screen.findByText("Everything stays on this Mac")).toBeInTheDocument();
    expect(screen.getByText("Always")).toBeInTheDocument();
    expect(
      screen.getByText(/Books never leave this computer\. When you ask about a passage/i),
    ).toBeInTheDocument();
  });

  it("the mode-aware line affirms nothing is sent in On this Mac only", async () => {
    wire({ ai_provider: "local" });
    render(<Settings />);
    await openPane("Privacy");
    expect(await screen.findByText(/nothing is sent/i)).toBeInTheDocument();
    expect(screen.getByText(/On this Mac only/)).toBeInTheDocument();
  });

  it("never claims answers are computed locally while the included (cloud) assistant is live", async () => {
    wire({ ai_provider: "company" });
    const { container } = render(<Settings />);
    await openPane("Privacy");
    await screen.findByText("Everything stays on this Mac");
    expect(screen.getByText(/included assistant/)).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/run on a local model/i);
  });

  it("the what's-left row shows the live count and opens the audit with plain lens labels, no hostname", async () => {
    const requests: AiRequest[] = [
      { id: "1", book_id: "b1", book_title: "The Yellow Wallpaper", mode: "section_briefing", locator: null, context_char_count: null, provider: "ai.readthroughline.com", created_at: "2026-06-10T09:48:00Z", wrote_to_memory: false },
      { id: "2", book_id: "b1", book_title: "The Yellow Wallpaper", mode: "explain", locator: null, context_char_count: null, provider: "ai.readthroughline.com", created_at: "2026-06-09T10:13:00Z", wrote_to_memory: true },
    ];
    wire({}, { requests });
    const { container } = render(<Settings />);
    await openPane("Privacy");
    const link = await screen.findByRole("button", { name: /2 passages · Show what was sent/ });
    fireEvent.click(link);
    const sheet = await screen.findByRole("dialog", { name: "What's left this Mac" });
    // Plain lens labels — NEVER the raw id; grouped by book, calm "Sent to assistant".
    expect(within(sheet).getByText("Section briefing")).toBeInTheDocument();
    expect(within(sheet).getByText("Explain")).toBeInTheDocument();
    expect(within(sheet).getByText(/The Yellow Wallpaper/)).toBeInTheDocument();
    expect(within(sheet).getAllByText(/Sent to assistant/).length).toBeGreaterThan(0);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/section_briefing/);
    expect(text).not.toMatch(/readthroughline/i);
    // Retention + Forget now live in the sheet.
    expect(within(sheet).getByText(/Keep this list for/i)).toBeInTheDocument();
    expect(within(sheet).getByText("90")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Forget now/i })).toBeInTheDocument();
  });

  it("shows a calm empty audit state when nothing has been sent", async () => {
    wire({}, { requests: [] });
    render(<Settings />);
    await openPane("Privacy");
    fireEvent.click(await screen.findByRole("button", { name: /0 passages · Show what was sent/ }));
    const sheet = await screen.findByRole("dialog", { name: "What's left this Mac" });
    expect(within(sheet).getByText(/Nothing has been sent\./i)).toBeInTheDocument();
  });
});

/* ═══════════════ Files pane ═══════════════ */

describe("Files pane", () => {
  it("shows the export folder by name — never the raw path", async () => {
    wire({ export_path: "/Users/x/Documents/Reading" });
    const { container } = render(<Settings />);
    await openPane("Files");
    const chip = await screen.findByRole("button", { name: "Change export folder" });
    await waitFor(() => expect(chip.textContent).toBe("Reading"));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\/Users\/x\/Documents\/Reading/);
    expect(text).not.toMatch(/Library\/Application Support/);
  });

  it("exports the library and confirms with the book count and folder name", async () => {
    wire({ export_path: "/Users/x/Documents/Reading" });
    const base = fullDto({ export_path: "/Users/x/Documents/Reading" });
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings": return Promise.resolve(base);
        case "cmd_export_library": return Promise.resolve({ exported: 3, root: "/Users/x/Documents/Reading" });
        case "cmd_list_ai_requests": return Promise.resolve([]);
        case "cmd_backup_status": return Promise.resolve({ enabled: true, last_backup_at: null });
        case "cmd_get_reading_pace": return Promise.resolve({ minutes: 25, chosen: true });
        default: return Promise.resolve(undefined);
      }
    });
    render(<Settings />);
    await openPane("Files");
    fireEvent.click(await screen.findByRole("button", { name: /Export/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("cmd_export_library"));
    const msg = await screen.findByText(/Exported 3 books to your Reading folder\./i);
    expect(msg.textContent).not.toMatch(/\/Users\/x\/Documents\/Reading/);
  });

  it("shows a calm, blame-free message when the library export fails", async () => {
    wire({});
    const base = fullDto({});
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings": return Promise.resolve(base);
        case "cmd_export_library": return Promise.reject(new Error("The export folder is read-only."));
        case "cmd_list_ai_requests": return Promise.resolve([]);
        case "cmd_backup_status": return Promise.resolve({ enabled: true, last_backup_at: null });
        case "cmd_get_reading_pace": return Promise.resolve({ minutes: 25, chosen: true });
        default: return Promise.resolve(undefined);
      }
    });
    render(<Settings />);
    await openPane("Files");
    fireEvent.click(await screen.findByRole("button", { name: /Export/ }));
    const err = await screen.findByText(/Couldn't export your library/i);
    expect(err.textContent).toMatch(/read-only/i);
    expect(err.textContent).toMatch(/Your books are unchanged/i);
    expect(err).toHaveClass("err");
  });

  it("automatic backups: shows the live last-backup line and round-trips the toggle", async () => {
    wire({}, { backup: { enabled: true, last_backup_at: new Date().toISOString() } });
    render(<Settings />);
    await openPane("Files");
    const toggle = await screen.findByRole("switch", { name: "Automatic backups" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/last backup today at/i)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_set_backups_enabled", { enabled: false }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("says 'no backup yet' honestly when none exists", async () => {
    wire({}, { backup: { enabled: false, last_backup_at: null } });
    render(<Settings />);
    await openPane("Files");
    expect(await screen.findByText(/no backup yet/i)).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Automatic backups" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("restore: lists backups, requires a choice, then calls cmd_restore_backup with the id", async () => {
    const backups: BackupEntry[] = [
      { id: "reading-20260708-091200.db", taken_at: new Date().toISOString() },
      { id: "reading-20260707-091200.db", taken_at: "2026-07-07T09:12:00-07:00" },
    ];
    wire({}, { backups });
    render(<Settings />);
    await openPane("Files");
    fireEvent.click(await screen.findByRole("button", { name: "Choose a backup" }));
    const sheet = await screen.findByRole("dialog", { name: "Restore from backup" });
    // Reassurance: the current library is kept safe first.
    expect(within(sheet).getByText(/Today's copy is kept safe first/i)).toBeInTheDocument();
    const restore = within(sheet).getByRole("button", { name: "Restore" });
    expect(restore).toBeDisabled();
    const rows = await within(sheet).findAllByRole("radio");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);
    expect(within(sheet).getByRole("button", { name: "Restore" })).toBeEnabled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("cmd_restore_backup", { id: "reading-20260708-091200.db" }),
    );
  });

  it("restore with no backups explains instead of a dead list", async () => {
    wire({}, { backups: [] });
    render(<Settings />);
    await openPane("Files");
    fireEvent.click(await screen.findByRole("button", { name: "Choose a backup" }));
    const sheet = await screen.findByRole("dialog", { name: "Restore from backup" });
    expect(within(sheet).getByText(/No backups yet/i)).toBeInTheDocument();
  });
});

/* ═══════════════ Shortcuts pane ═══════════════ */

describe("Shortcuts pane", () => {
  it("lists the six real shortcuts with kbd chips", async () => {
    wire({});
    const { container } = render(<Settings />);
    await openPane("Shortcuts");
    for (const what of [
      "Ask about the selection",
      "Add a note",
      "Search your library",
      "Bigger or smaller text",
      "Toggle theme",
      "Settings",
    ]) {
      expect(await screen.findByText(what)).toBeInTheDocument();
    }
    expect(container.querySelectorAll(".set-kbd")).toHaveLength(6);
    expect(screen.getByText("⌘ E")).toBeInTheDocument();
    expect(screen.getByText("⌘ ⇧ L")).toBeInTheDocument();
    expect(screen.getByText("⌘ ,")).toBeInTheDocument();
  });
});

/* ═══════════════ Send feedback destination ═══════════════ */

describe("Send feedback destination", () => {
  it("opens from the rail and returns to the previously viewed pane on Cancel", async () => {
    wire({});
    render(<Settings />);
    await openPane("Privacy");
    await screen.findByText("Everything stays on this Mac");
    await openPane("Send feedback");
    expect(await screen.findByRole("heading", { name: "Send feedback" })).toBeInTheDocument();
    expect(screen.getByText(/A note goes straight to the people building Throughline\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back on Privacy — the pane the reader came from.
    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeInTheDocument();
  });
});

/* ═══════════════ Software Update destination (CORE-1193) ═══════════════ */

describe("Software Update destination", () => {
  it("is on the rail and renders the live update state with the version line", async () => {
    wire({});
    render(<Settings />);
    await openPane("Software Update");
    expect(await screen.findByRole("heading", { name: "Software Update" })).toBeInTheDocument();
    // Idle machine + the diagnostics version → an honest version line, a
    // working manual check, and the auto-download toggle. Never a dead end.
    expect(await screen.findByText("You are on version 0.8.4.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Download updates automatically" }),
    ).toBeInTheDocument();
  });

  it("jumps straight to Software Update when the app menu asks (jumpToUpdate)", async () => {
    wire({});
    const consumed = vi.fn();
    render(<Settings jumpToUpdate onJumpConsumed={consumed} />);
    expect(await screen.findByRole("heading", { name: "Software Update" })).toBeInTheDocument();
    expect(consumed).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════════ Voice: no plumbing words ═══════════════ */

describe("reader-facing voice", () => {
  it("uses plain words only across every pane — no tokens / endpoint / hostnames", async () => {
    wire({});
    const { container } = render(<Settings />);
    for (const pane of ["Reading", "Appearance", "Assistant", "Privacy", "Files", "Shortcuts", "Software Update"]) {
      await openPane(pane);
      await screen.findByRole("heading", { name: pane });
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/token/i);
      expect(text).not.toMatch(/endpoint/i);
      expect(text).not.toMatch(/readthroughline/i);
      expect(text).not.toMatch(/\$\d/);
    }
  });
});

/* ═══════════════ fmtBackupWhen ═══════════════ */

describe("fmtBackupWhen", () => {
  const now = new Date(2026, 6, 8, 14, 0, 0); // Jul 8 2026, 2pm local
  it("reads today / yesterday / date for the backup timestamp", () => {
    expect(fmtBackupWhen(new Date(2026, 6, 8, 9, 12).toISOString(), now)).toMatch(/^today at 9:12/i);
    expect(fmtBackupWhen(new Date(2026, 6, 7, 18, 3).toISOString(), now)).toMatch(/^yesterday at 6:03/i);
    expect(fmtBackupWhen(new Date(2026, 5, 30, 9, 12).toISOString(), now)).toMatch(/^Jun 30 at 9:12/i);
  });
  it("returns empty for garbage rather than echoing it", () => {
    expect(fmtBackupWhen("not-a-date", now)).toBe("");
  });
});

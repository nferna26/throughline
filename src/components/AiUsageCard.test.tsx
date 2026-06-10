import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import AiUsageCard from "./AiUsageCard";
import type { UsageSummary } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const SUMMARY: UsageSummary = {
  total_calls: 7,
  total_cost_micros: 123_400,
  month_cost_micros: 56_700,
  spend_cap_cents: 500,
  by_provider: [{ key: "anthropic", calls: 7, cost_micros: 123_400 }],
  by_lens: [],
  pricing_verified_at: "2026-06-01",
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "cmd_get_usage_summary" ? Promise.resolve(SUMMARY) : Promise.resolve(undefined),
  );
});

describe("AiUsageCard — BYO (own key) mode", () => {
  it("shows spend figures and the monthly cap input, in plain words (no 'token')", async () => {
    const { container } = render(<AiUsageCard provider="anthropic" />);
    await waitFor(() => expect(screen.getByText("Spend so far")).toBeInTheDocument());
    // Real dollar figures + the per-provider breakdown chip.
    expect(screen.getByText("$0.1234")).toBeInTheDocument();
    expect(screen.getByText(/anthropic: \$0\.1234 · 7/)).toBeInTheDocument();
    // The cap input stays — it genuinely applies to a reader paying their provider.
    expect(screen.getByLabelText(/Monthly AI spend cap/i)).toBeInTheDocument();
    // Plain language: the estimate is described without plumbing words.
    expect(screen.getByText(/Estimated from your recorded usage at catalogued prices/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/token/i);
  });
});

describe("AiUsageCard — company mode (one-time purchase)", () => {
  it("reframes to 'Included in your one-time purchase' — no dollars, no cap input", async () => {
    const { container } = render(<AiUsageCard provider="company" />);
    expect(await screen.findByText(/Included in your one-time purchase/i)).toBeInTheDocument();
    // The paid promise: explanations, never tokens or dollars.
    expect(container.textContent).not.toMatch(/\$/);
    expect(container.textContent).not.toMatch(/token/i);
    expect(screen.queryByText("Spend so far")).toBeNull();
    expect(screen.queryByLabelText(/Monthly AI spend cap/i)).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import CompanyPanel, { fuel } from "./CompanyPanel";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn((_cmd: string): Promise<unknown> => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

beforeEach(() => {
  cleanup();
  mocks.invoke.mockReset();
});

describe("fuel()", () => {
  it("does not claim 'Almost out' when credits simply can't be checked (CORE-1006)", () => {
    // A network blip or proxy 5xx yields null / status "unknown" — that is not
    // a spent allowance, and the gauge must not say it is.
    expect(fuel(null)).toEqual({ label: "Can't check right now", level: "unavailable" });
    expect(
      fuel({ status: "unknown", remaining_fraction: 0, approx_questions_left: 0 }),
    ).toEqual({ label: "Can't check right now", level: "unavailable" });
  });

  it("still reports the real low state for an active license", () => {
    expect(
      fuel({ status: "active", remaining_fraction: 0.05, approx_questions_left: 3 }),
    ).toEqual({ label: "Almost out", level: "empty" });
  });
});

describe("CompanyPanel (activated, credits unreachable)", () => {
  it("shows the can't-check copy plus reassurance — not an empty bar", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "cmd_company_status") {
        return Promise.resolve({ provider_active: true, has_license: true });
      }
      if (cmd === "cmd_company_credits") {
        return Promise.reject(new Error("relay unavailable"));
      }
      return Promise.resolve(null);
    });

    render(<CompanyPanel onActivated={() => {}} />);

    const gauge = await screen.findByRole("status");
    expect(gauge).toHaveTextContent(/can't check right now/i);
    expect(gauge).toHaveTextContent(/the tutor still answers/i);
    expect(gauge.className).not.toMatch(/\bempty\b/);
    expect(screen.queryByText(/almost out/i)).toBeNull();
  });
});

describe("CompanyPanel (deep-link activation while Settings is open)", () => {
  it("reloads status when the tl-company-activated event fires", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "cmd_company_status") {
        return Promise.resolve({ provider_active: false, has_license: false });
      }
      return Promise.resolve(null);
    });

    render(<CompanyPanel onActivated={() => {}} />);
    await screen.findByText(/\$20 once/);
    const callsBefore = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "cmd_company_status").length;
    expect(callsBefore).toBeGreaterThan(0);

    window.dispatchEvent(new Event("tl-company-activated"));

    await vi.waitFor(() => {
      const callsAfter = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "cmd_company_status").length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import TutorFuel, { fuelTone, FUEL_NUDGE_75, FUEL_NUDGE_90 } from "./TutorFuel";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn((_cmd: string): Promise<unknown> => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

function setCredits(remaining: number, status = "active") {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) =>
    cmd === "cmd_company_credits"
      ? Promise.resolve({ status, remaining_fraction: remaining, approx_questions_left: 42 })
      : Promise.resolve(null),
  );
}

beforeEach(() => cleanup());

describe("fuelTone thresholds (on the USED fraction)", () => {
  it("is quiet below 75% used, nudges at 75%, goes low at 90%", () => {
    expect(fuelTone(0)).toBe("quiet");
    expect(fuelTone(0.74)).toBe("quiet");
    expect(fuelTone(0.75)).toBe("nudge");
    expect(fuelTone(0.89)).toBe("nudge");
    expect(fuelTone(0.9)).toBe("low");
    expect(fuelTone(1)).toBe("low");
  });
});

describe("TutorFuel", () => {
  it("renders nothing outside company mode (and never fetches credits)", () => {
    setCredits(0.5);
    const { container } = render(<TutorFuel provider="anthropic" />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("is a bare quiet strip under 75% used — no nudge text, no dollars", async () => {
    setCredits(0.5); // 50% used
    render(<TutorFuel provider="company" />);
    expect(await screen.findByRole("status")).toHaveAccessibleName(/about 50% left/);
    expect(screen.queryByText(FUEL_NUDGE_75)).toBeNull();
    expect(screen.queryByText(FUEL_NUDGE_90)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("shows the gentle free-path nudge at ≥75% used", async () => {
    setCredits(0.2); // 80% used
    render(<TutorFuel provider="company" />);
    expect(await screen.findByText(FUEL_NUDGE_75)).toBeInTheDocument();
    expect(screen.queryByText(FUEL_NUDGE_90)).toBeNull();
  });

  it("shows the clearer nudge at ≥90% used", async () => {
    setCredits(0.07); // 93% used
    render(<TutorFuel provider="company" />);
    expect(await screen.findByText(FUEL_NUDGE_90)).toBeInTheDocument();
  });

  it("renders nothing when the license is not active (cap screen owns that state)", async () => {
    setCredits(0, "exhausted");
    const { container } = render(<TutorFuel provider="company" />);
    // allow the credits promise to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});

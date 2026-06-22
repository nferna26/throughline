import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import TutorFuel, { fuelTone } from "./TutorFuel";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn((_cmd: string): Promise<unknown> => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

function setCredits(remaining: number, status = "active", left = 42) {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) =>
    cmd === "cmd_company_credits"
      ? Promise.resolve({ status, remaining_fraction: remaining, approx_questions_left: left })
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

describe("TutorFuel — low-allowance strip", () => {
  it("renders nothing outside company mode (and never fetches credits)", () => {
    setCredits(0.5);
    const { container } = render(<TutorFuel provider="anthropic" />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("is ABSENT entirely until the allowance is low (under 75% used)", async () => {
    setCredits(0.5); // 50% used → not low
    const { container } = render(<TutorFuel provider="company" />);
    // allow the credits promise to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a calm low-note at >=75% used: no count, no bar, no percent, no dollars (no-counter rule)", async () => {
    setCredits(0.2, "active", 12); // 80% used
    const { container } = render(<TutorFuel provider="company" />);
    expect(
      await screen.findByText(
        /Included tutoring is running low\. It keeps working with your own key or a local model, free\./i,
      ),
    ).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/12/); // no raw count
    expect(text).not.toMatch(/%/); // no percent
    expect(text).not.toMatch(/\$/); // no dollars
    expect(container.querySelector(".tl-fuel-bar, .fill, [role='progressbar']")).toBeNull(); // no depleting bar
  });

  it("still shows the calm low-note at >=90% used (still no count)", async () => {
    setCredits(0.07, "active", 3); // 93% used
    const { container } = render(<TutorFuel provider="company" />);
    expect(await screen.findByText(/Included tutoring is running low/i)).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/\b3\b/);
  });

  it("renders nothing when the license is not active (cap screen owns that state)", async () => {
    setCredits(0, "exhausted");
    const { container } = render(<TutorFuel provider="company" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});

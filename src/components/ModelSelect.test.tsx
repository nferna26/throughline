import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ModelSelect from "./ModelSelect";
import type { ModelInfo } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const CATALOG: ModelInfo[] = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet", input_per_mtok: 3, output_per_mtok: 15, tier: "default" },
];

beforeEach(() => {
  cleanup();
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "cmd_model_catalog" ? Promise.resolve(CATALOG) : Promise.resolve(undefined),
  );
});

describe("ModelSelect — price chip", () => {
  it("speaks the cost plainly: both prices, no 'tokens' (CORE-1024)", async () => {
    render(<ModelSelect provider="anthropic" value="claude-sonnet-4-6" onChange={() => {}} />);
    const chip = await screen.findByLabelText(/Costs 3 dollars per million for what you send/i);
    expect(chip).toHaveAccessibleName(
      "Costs 3 dollars per million for what you send and 15 per million for what it writes back",
    );
    expect(chip.getAttribute("aria-label")).not.toMatch(/token/i);
  });
});

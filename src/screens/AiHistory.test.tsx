import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiHistory from "./AiHistory";
import type { AiRequest } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const rows: AiRequest[] = [
  {
    id: "a2", book_id: "b", book_title: "The Cold Start Problem", mode: "socratic",
    locator: "char:1", context_char_count: 20, provider: "localhost",
    created_at: "2026-05-03T12:00:00Z", wrote_to_memory: true,
  },
  {
    id: "a1", book_id: "b", book_title: "The Cold Start Problem", mode: "explain",
    locator: "char:0", context_char_count: 10, provider: null,
    created_at: "2026-05-01T12:00:00Z", wrote_to_memory: false,
  },
];

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "cmd_list_ai_requests") return Promise.resolve(rows);
    if (cmd === "cmd_forget_ai_history") return Promise.resolve(2);
    if (cmd === "cmd_set_ai_settings") return Promise.resolve({});
    return Promise.resolve(undefined);
  });
});

describe("AiHistory", () => {
  it("distinguishes a preview that never left the machine from a sent Ask call", async () => {
    render(<AiHistory retentionDays={90} onSettingsChanged={() => {}} />);
    // The sent row (provider=localhost) and the preview row (provider=null,
    // tagged "Local") — the audit distinction.
    expect(await screen.findByText(/Sent → localhost/)).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText(/never leave this Mac/i)).toBeInTheDocument();
    // Mode labels are humanized and the saved-as-note row is marked.
    expect(screen.getByText("Ask questions")).toBeInTheDocument();
    expect(screen.getByText(/saved as note/)).toBeInTheDocument();
  });

  it("runs the retention sweep via a confirm step when Forget now is used", async () => {
    const user = userEvent.setup();
    render(<AiHistory retentionDays={90} onSettingsChanged={() => {}} />);
    await screen.findByText("Ask questions");

    await user.click(screen.getByRole("button", { name: /Forget now/ }));
    await user.click(await screen.findByRole("button", { name: /Yes, forget them/ }));

    expect(mockInvoke).toHaveBeenCalledWith("cmd_forget_ai_history");
  });
});

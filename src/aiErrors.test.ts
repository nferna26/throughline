import { describe, it, expect } from "vitest";
import { humanizeError, looksUnavailable } from "./aiErrors";

// CORE-1005 [P2-7]: error copy must be provider-aware. A paid (company) or
// cloud reader must never be told to check LM Studio, and no message may
// point at a settings section that doesn't exist — it's called Assistance.

const CONNECTION_RAW = "request failed: connection refused";

// The stale pointer copy must never reappear. Built by concatenation so a
// repo-wide grep for the banned phrase stays clean.
const BANNED_POINTER = "Settings → " + "AI";

/** One raw input per mapped branch of humanizeError, plus an unmapped one. */
const MAPPED_RAWS = [
  "No AI model name set",
  CONNECTION_RAW,
  "could not reach the server",
  "service unavailable",
  "local-only mode refused this endpoint",
];

const PROVIDERS = ["company", "local", "openai", "anthropic", "codex", "none"];

describe("humanizeError — provider-aware copy", () => {
  it("company + connection failure speaks of Throughline AI, never LM Studio/Ollama", () => {
    const msg = humanizeError("company", CONNECTION_RAW);
    expect(msg).toContain("Throughline AI");
    expect(msg).toMatch(/connection|try again/i);
    expect(msg).not.toContain("LM Studio");
    expect(msg).not.toContain("Ollama");
  });

  it("anthropic + connection failure names the provider (aiProviderLabel), no LM Studio", () => {
    const msg = humanizeError("anthropic", CONNECTION_RAW);
    expect(msg).toContain("Anthropic");
    expect(msg).not.toContain("LM Studio");
    expect(msg).not.toContain("Ollama");
  });

  it("local + connection failure keeps the LM Studio / Ollama guidance", () => {
    const msg = humanizeError("local", CONNECTION_RAW);
    expect(msg).toContain("LM Studio");
    expect(msg).toContain("Ollama");
  });

  it("never points at the stale settings section for any provider × any mapped message", () => {
    for (const provider of PROVIDERS) {
      for (const raw of MAPPED_RAWS) {
        const msg = humanizeError(provider, raw);
        expect(msg, `provider=${provider} raw=${raw}`).not.toContain(BANNED_POINTER);
        if (msg.includes("Settings →")) {
          expect(msg, `provider=${provider} raw=${raw}`).toContain("Settings → Assistance");
        }
      }
    }
  });

  it("strips a leading 'error:' prefix from unmapped messages", () => {
    expect(humanizeError("company", "Error: something odd")).toBe("something odd");
  });
});

describe("looksUnavailable — current behavior pinned", () => {
  it.each([
    "Can't reach the local model server.",
    "cannot reach the server",
    "could not reach host",
    "connection refused",
    "service unavailable",
    "refused to connect",
    "No model is loaded.",
    "the request timed out",
    "timeout while waiting",
  ])("treats %j as unavailable", (msg) => {
    expect(looksUnavailable(msg)).toBe(true);
  });

  it("does not treat a hard config error as unavailable", () => {
    expect(looksUnavailable("invalid API key")).toBe(false);
    expect(looksUnavailable("Local-only mode is on.")).toBe(false);
  });

  it("humanized connection errors still read as unavailable (recovery sheet keeps working)", () => {
    for (const provider of PROVIDERS) {
      expect(
        looksUnavailable(humanizeError(provider, CONNECTION_RAW)),
        `provider=${provider}`,
      ).toBe(true);
    }
  });
});

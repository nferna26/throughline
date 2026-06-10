import { aiProviderLabel } from "./types";

/**
 * Shared reader-facing copy for tutor / briefing failures (CORE-1005).
 *
 * The copy is provider-aware: a reader on the included Throughline AI (or any
 * cloud provider) is never told to check LM Studio, and every settings pointer
 * names the section that actually exists — Settings → Assistance.
 */

/** True when an error message reads like the configured provider is unreachable
 *  (vs. a hard config error), so the caller offers the "Tutor paused" recovery. */
export function looksUnavailable(msg: string): boolean {
  const s = msg.toLowerCase();
  return (
    s.includes("can't reach") ||
    s.includes("cannot reach") ||
    s.includes("could not reach") ||
    s.includes("connection") ||
    s.includes("unavailable") ||
    s.includes("refused") ||
    s.includes("no model is loaded") ||
    s.includes("timed out") ||
    s.includes("timeout")
  );
}

/** Turn a raw failure into calm, provider-aware copy: what happened, what to
 *  do next. `provider` is the settings id ("company" | "local" | "openai" |
 *  "anthropic" | "codex"); anything else falls back to a neutral label. */
export function humanizeError(provider: string | null | undefined, raw: string): string {
  const s = raw.toLowerCase();
  const local = provider === "local";
  const label = aiProviderLabel(provider ?? "");

  if (s.includes("no ai model") || s.includes("model name set")) {
    return local
      ? "No model is loaded. Open your local model server (LM Studio or Ollama) and load a model, then try again."
      : `${label} doesn't have a model picked yet. Choose one in Settings → Assistance, then try again.`;
  }
  if (
    s.includes("request failed") ||
    s.includes("could not reach") ||
    s.includes("connection") ||
    s.includes("unavailable") ||
    s.includes("refused")
  ) {
    return local
      ? "Can't reach the local model server. Is LM Studio (or Ollama) running on this Mac?"
      : `Can't reach ${label} right now. Check that this Mac is online, then try again.`;
  }
  if (s.includes("local-only")) {
    return "Local-only mode is on, so nothing was sent off this Mac. To use a cloud assistant, turn local-only off in Settings → Assistance.";
  }
  return raw.replace(/^error:\s*/i, "");
}

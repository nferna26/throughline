// P0 quit-flush regression: before this module existed, nothing anywhere flushed
// the sitting on quit/window close (grep for pagehide/onCloseRequested/beforeunload
// across src + src-tauri came back empty), so Cmd+Q lost minutes, completion, and
// the sitting roll-forward. These tests pin the wiring contract.
import { describe, expect, it, vi } from "vitest";

import { registerQuitFlush } from "./sessionQuitFlush";

describe("registerQuitFlush", () => {
  it("fires the flush on pagehide (the quit/window-close teardown signal)", () => {
    const flush = vi.fn();
    const unregister = registerQuitFlush(flush);
    window.dispatchEvent(new Event("pagehide"));
    expect(flush).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("double teardown signals are delivered as-is (idempotence lives in flushSession)", () => {
    const flush = vi.fn();
    const unregister = registerQuitFlush(flush);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    expect(flush).toHaveBeenCalledTimes(2);
    unregister();
  });

  it("unregister removes the listener (no flush after the sitting ended normally)", () => {
    const flush = vi.fn();
    const unregister = registerQuitFlush(flush);
    unregister();
    window.dispatchEvent(new Event("pagehide"));
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not throw outside Tauri (the dynamic window import is best-effort)", async () => {
    const flush = vi.fn();
    const unregister = registerQuitFlush(flush);
    // Let the dynamic import settle; under vitest it rejects and must be swallowed.
    await new Promise((r) => setTimeout(r, 0));
    unregister();
    expect(flush).not.toHaveBeenCalled();
  });
});

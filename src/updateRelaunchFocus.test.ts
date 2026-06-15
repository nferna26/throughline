import { describe, it, expect, vi } from "vitest";
import { focusAfterUpdateRelaunchIfNeeded } from "./updateRelaunchFocus";

describe("update relaunch focus handoff", () => {
  it("does nothing on a normal cold launch", async () => {
    const focusOps = vi.fn(() => Promise.resolve());

    const focused = await focusAfterUpdateRelaunchIfNeeded(
      () => Promise.resolve(false),
      focusOps,
    );

    expect(focused).toBe(false);
    expect(focusOps).not.toHaveBeenCalled();
  });

  it("focuses exactly when the fresh process consumes an update-relaunch marker", async () => {
    const focusOps = vi.fn(() => Promise.resolve());

    const focused = await focusAfterUpdateRelaunchIfNeeded(
      () => Promise.resolve(true),
      focusOps,
    );

    expect(focused).toBe(true);
    expect(focusOps).toHaveBeenCalledTimes(1);
  });

  it("fails closed if the marker check or OS focus call fails", async () => {
    await expect(
      focusAfterUpdateRelaunchIfNeeded(
        () => Promise.reject(new Error("ipc unavailable")),
        () => Promise.resolve(),
      ),
    ).resolves.toBe(false);

    await expect(
      focusAfterUpdateRelaunchIfNeeded(
        () => Promise.resolve(true),
        () => Promise.reject(new Error("window unavailable")),
      ),
    ).resolves.toBe(false);
  });
});

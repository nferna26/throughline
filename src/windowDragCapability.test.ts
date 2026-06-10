import { describe, it, expect } from "vitest";
// CORE-1038 / FT-04: the custom titlebar can only move the window if the
// capability grants `core:window:allow-start-dragging` — Tauri's injected drag
// handler invokes `plugin:window|start_dragging`, which `core:default` does NOT
// include. Without the grant the ACL denies it and the window silently never
// moves. The real shipped capability, imported as a JSON module (not via
// node:fs) so this stays a frontend test — the discoverShelves.test.ts idiom.
import caps from "../src-tauri/capabilities/default.json";

// App.tsx as raw source (the deadScreens.test.ts idiom) — pins the frontend
// half: the titlebar's drag regions must stay in place for the grant to matter.
const sources = import.meta.glob("./App.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("window dragging (CORE-1038)", () => {
  it("the main-window capability grants core:window:allow-start-dragging", () => {
    expect(caps.permissions).toContain("core:window:allow-start-dragging");
  });

  it("App.tsx keeps the titlebar drag regions the grant exists for", () => {
    const app = sources["./App.tsx"];
    expect(app, "src/App.tsx not found by the source glob").toBeTruthy();
    expect(app).toMatch(/data-tauri-drag-region/);
  });
});

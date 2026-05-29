// Registers jest-dom matchers (toBeInTheDocument, etc.) on Vitest's `expect`
// and augments its types. Loaded via vitest.config `setupFiles`.
import "@testing-library/jest-dom/vitest";

// This jsdom build doesn't expose localStorage; the readers persist font-size /
// line-width there. Provide a minimal in-memory shim so component tests render.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
  });
}

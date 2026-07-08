// P0 quit-flush: quitting (Cmd+Q) or closing the window is the most common way a
// reader leaves a sitting, and before this module NOTHING flushed the session on
// those paths — minutes, section completion, and the sitting roll-forward were
// lost and Today re-served the same sitting. The flush itself (`flushSession` in
// TextReader) is already idempotent via `endedRef`, so this module only owns the
// WIRING: fire the flush on every teardown signal, double-fire safe.
//
// Two signals, belt and braces:
//  - DOM `pagehide`: fired by WKWebView when the page is torn down (window close
//    and app quit). `visibilitychange` is deliberately NOT used — hiding the app
//    (Cmd+H, app switch) is not the end of a sitting.
//  - Tauri `onCloseRequested` (red-light close). Best-effort dynamic import, same
//    pattern as every other Tauri listener in this codebase, so the module is a
//    no-op under vitest / the browser harness.
//
// The flush must post its IPC synchronously when called (TextReader's
// `flushSession` reaches `invoke` with no awaits before it), so the message is in
// flight even as the webview tears down; the Rust launch sweep
// (`sweep_orphan_sessions`) backstops the true hard-kill case.

/** Register quit-flush listeners. Returns an unregister function. */
export function registerQuitFlush(flush: () => void): () => void {
  const onPageHide = () => flush();
  window.addEventListener("pagehide", onPageHide);

  let unlistenClose: (() => void) | undefined;
  let disposed = false;
  (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const un = await getCurrentWindow().onCloseRequested(() => flush());
      // The register/unregister race: if we were disposed while awaiting, drop it.
      if (disposed) un();
      else unlistenClose = un;
    } catch {
      /* not running under Tauri — pagehide alone covers the harness */
    }
  })();

  return () => {
    disposed = true;
    window.removeEventListener("pagehide", onPageHide);
    unlistenClose?.();
  };
}

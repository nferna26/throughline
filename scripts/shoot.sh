#!/usr/bin/env bash
# Capture the LIVE Throughline window (the running `npm run tauri dev` app) to a
# PNG the agent can read — the real-app spot-check layer of the self-verify loop.
# The browser harness (npm run verify:ui) drives the UI against a fake backend;
# this confirms the real app (real Rust backend + WKWebView) matches.
#
# Requires: the dev app running, and (for a window-cropped shot) Accessibility +
# Screen-Recording permission for your terminal. Falls back to a full-screen grab.
set -uo pipefail
OUT="${1:-/tmp/throughline-shot.png}"

read -r X Y W H < <(osascript <<'OSA' 2>/dev/null || echo "0 0 0 0"
tell application "System Events"
  set procs to (every process whose name contains "hroughline")
  if (count of procs) = 0 then return "0 0 0 0"
  set p to item 1 of procs
  if (count of windows of p) = 0 then return "0 0 0 0"
  set w to window 1 of p
  set {x, y} to position of w
  set {ww, hh} to size of w
  return (x as text) & " " & (y as text) & " " & (ww as text) & " " & (hh as text)
end tell
OSA
)

if [ "${W:-0}" != "0" ]; then
  screencapture -x -R"${X},${Y},${W},${H}" "$OUT" && echo "captured window → $OUT (${W}x${H})"
else
  echo "Window bounds unavailable (grant Accessibility to your terminal, or the app isn't running) — full-screen fallback."
  screencapture -x "$OUT" && echo "captured screen → $OUT"
fi

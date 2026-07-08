# Fix report — reading-gym (branch `fable/fixes-batch-1`)

Highest-leverage fixes from the pre-launch review (`docs/reviews/feature-review.md` on
`fable/review-and-docs`), one commit per finding, each with a regression test that fails (or
a precise repro) before and passes after. **No merge.** Branched from current `origin/main`
(CORE-1169 merged). The money-path fix (P1-3) is flagged for careful human review.

## Fixes (each confirmed real, then fixed)

### 1. [P0] Reading progress lost on Cmd+Q / window close — `053914c`
**Real.** No `pagehide`/`onCloseRequested`/`beforeunload` handler existed anywhere (grep of
`src` + `src-tauri` was empty); `cmd_end_session` fired only from in-app Finish / toolbar
back. Quitting mid-sitting stranded the session open forever: minutes lost, completion never
recorded, sitting never rolled forward, Today re-served the same section.
**Fix.** (a) `src/sessionQuitFlush.ts`: register `pagehide` + Tauri `onCloseRequested` to
call the existing idempotent `flushSession` (wired in TextReader via a ref kept current).
(b) `sweep_orphan_sessions` at launch closes sessions a hard kill left open, HONESTLY —
`ended_at`/`minutes` from the last durable reading evidence (`reading_position.updated_at`),
never wall-clock-at-relaunch; no evidence → close at `started_at`, minutes NULL; idempotent.
**Tests.** `sessionQuitFlush.test.ts` (4, wiring); `sweep_orphan_sessions_closes_open_rows_honestly`
(evidence-based close, honest-unknown, no-touch of closed rows).

### 2. [P1/MONEY — review carefully] Mid-stream tutor double-charge — `e3a2f30`
**Real.** The relay bills an answer as it streams. Switching the active card or navigating
sections mid-stream unmounted the streaming `MarginTutorCard` before "done", so `onCached`
never fired; reopening saw `!cached` and auto-fired a fresh `cmd_ai_ask` — the reader paid
twice and never saw the first answer.
**Fix (app-side only; does NOT touch the $8 cap, minting, or amount integrity).** On unmount
of a started-but-unsettled stream, persist an *interrupted* snapshot to the parent draft
cache, so reopen replays instead of firing a second billable call. `startedRef` marks an
in-flight billed stream (set only after `cmd_ai_ask` resolves, so a consent/cap rejection
never counts); `doneRef`/`completedFreshRef` stop the snapshot from clobbering a real
completion and stop a pure replay from silently healing the interrupted flag. UI shows an
honest "interrupted — Ask again" affordance (explicit single re-ask).
**Tests (MarginTutorCard.test.tsx).** Mid-stream unmount persists interrupted + reopen fires
NO second `cmd_ai_ask` (double-charge gone); a normal single ask fires exactly one call and
completes to a clean cache (single charge works); replay never re-charges nor heals the flag.
**Cap proof.** The $8 cap is relay-side and untouched — the relay's `cap.test.ts` stays green
(27/27), demonstrating the cap + normal single charge still work.

### 3. [P1/DATA-LOSS] Silent YAML-frontmatter deletion on re-export (N-1) — `e9cb519`
**Real.** `parse_existing_frontmatter` kept only colon lines and re-emitted them flat, so a
reader's `tags:` / `aliases:` list items (`  - reading`) were dropped and `tags:` was left
value-less on every note-save re-export.
**Fix.** Preserve non-owned frontmatter verbatim, including indented block scalars and
`- item` list lines.
**Test.** `reexport_preserves_multiline_list_frontmatter` (list items + flow list survive);
existing frontmatter/reexport tests stay green.

### 4. [P1] Malformed Gutenberg `.txt` panics the import command (N-3) — `2fa33f5`
**Real.** `&raw[body_start..body_end]` panicked when a file's END marker preceded its START
(`body_start > body_end`) inside a `#[tauri::command]`.
**Fix.** `body_end.max(body_start)`; a reversed pair yields an empty body the existing guard
refuses cleanly.
**Test.** `import_txt_with_end_marker_before_start_does_not_panic` (panics before / Err after).

### 5. [P1] Notes mis-filed under prefix-colliding chapter headings (N-2) — `72c738b`
**Real.** `find_heading` used `body.find("\n## Book I")`, matching the prefix of "## Book II".
A "Book I" note added out of order was filed under "Book II" and never healed (Augustine
Book I..XIII is maximally colliding).
**Fix.** Whole-line match (followed by newline or end-of-string), scanning past prefix hits.
**Test.** `find_heading_requires_a_whole_line_not_a_prefix`.

### 6. [P1] Discover download error leaks the source URL/brand (N-5) — `6f00391`
**Real (by inspection + reqwest's documented Display).** A failed download wrapped the
reqwest error as `format!("download failed: {e}")`; the error's Display embeds the request
URL (`https://www.gutenberg.org/...`), serialized to the reader in Discover — the store
posture's one runtime brand leak. (A real network repro is banned in the default suite.)
**Fix.** Both download-failure sites (send + mid-stream chunk) return a fixed brand-free
message and `tracing::warn!` the detail to the log only.
**Test.** `download_failure_copy_never_leaks_the_source_brand_or_url` (copy carries no
URL/brand/em-dash).

### 7. [P1] Activation brands a throttled/transient relay response as invalid (P1-4) — `d166cb4`
**Real.** `cmd_activate_company` mapped every non-2xx to "invalid, expired, or already used,"
including 429 (multi-device throttle on a valid code) and 5xx (transient), telling a paying
reader their good code was bad at the $20 first-run moment.
**Fix.** Extracted `activation_error_message`: 429 → "wait a little while, then try again";
5xx → "briefly unavailable, try again"; other 4xx → the permanent invalid copy.
**Test.** `activation_error_message_distinguishes_transient_from_permanent`.

### 8. [P1] Backend locator parse is a silent no-op vs invariant 4a (P1-6) — `fe174a2`
**Real.** `if let Ok(g) = locator.trim().parse::<i64>()` with no else: a non-bare-digit
locator was stored while `reading_position` silently never advanced — the exact Stage-2 case
law 4a exists for. (No live bug today; frontend pinned to bare digits.)
**Fix.** `parse_reading_offset` (single owner) logs at error level and returns Err on
non-numeric; `cmd_save_section_progress` propagates (real save failure), `cmd_end_session`
logs loudly and skips the advance without failing session-end.
**Tests.** `parse_reading_offset_is_loud_on_non_numeric`,
`save_section_progress_rejects_a_non_bare_digit_locator`.

### 9. [P1] Deep Study briefing renders "[object Object]" + dead-ends (P1-2) — `76100ee`
**Real.** `NeedsCloudConsent`/`CapExhausted` carried no `message`, so the briefing catch's
`String(e.message ?? e)` rendered "[object Object]" and Try again re-fired forever.
**Fix.** (a) Backstop: both AppError variants now serialize a non-empty `message` (kind/host
preserved). (b) Briefing card branches on `err.kind` for actionable copy, else
`errorMessage()`.
**Tests.** `consent_and_cap_errors_serialize_a_message_backstop` (Rust);
cap-exhausted + needs-consent briefing tests assert real copy, never "[object Object]".

## Considered and deliberately deferred (left as reports, not fixed)

- **N-4 — cold-start activation deep-link token drop.** Real, but the fix (a Rust-side
  pending-token stash + a `cmd_take_pending_activation` the frontend polls on mount, or the
  deep-link plugin's `getCurrent()`) reworks the single-instance/activation launch lifecycle
  and needs a Tauri-lifecycle test harness — larger than a one-commit fix and adjacent to the
  activation/money path. Warrants its own scoped pass.
- **App security P1 — `throughline://activate` "consent bypass."** Reclassified as by-design
  / low severity: activating company mode IS the reader's first-cloud consent (error.rs +
  `commands/ai.rs` comments), and the link needs a VALID relay-issued token (an invalid one
  errors), so it is not a silent bypass an attacker can trigger. Left as a report.
- **Relay/site security P1s.** Per the guardrails (security P1s only if small/self-contained;
  do not touch the money flow): the relay `/v1/tutor` server-side prompt/selection binding is
  a substantial relay redesign; the unauthenticated-checkout amplification rate-limit and the
  payment-page CSP both sit on the money-adjacent flow. All left as reports for a dedicated
  money-path pass.

## Gate

- Frontend: `npx vitest run` → 439 passed (41 files); `npm run typecheck` clean; `npm run
  build` OK.
- Rust: `cargo test --all-targets` — see the run below (reported green in the session).
- Relay (untouched by these fixes): `cap.test.ts` 27/27, demonstrating the $8 cap still works.

No merge. P1-3 (money) and anything cost-adjacent flagged for careful human review.

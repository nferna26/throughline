# Throughline Audit Index

Last reconciled: 2026-08-30 (v0.9.3 prelaunch pass).

This file exists because `CLAUDE.md` asks agents to reconcile against `docs/AUDIT.md` after their own sweep. Treat this as the current audit index; older review files remain useful evidence, but the shipped code and `CLAUDE.md` are authoritative when they disagree.

## Current launch-readiness checks

- Product promise docs: `README.md`, `docs/IPC.md`, and `docs/AI_PROVIDERS.md` should describe the current Throughline shape: Today-first, sitting-based progress, `~/Documents/Throughline` exports, bundled offline Discover search, paid Throughline AI activation, BYO/local AI, and no forced first-run AI chooser.
- IPC surface: every command registered in `src-tauri/src/lib.rs` should have a `#### cmd_*` entry in `docs/IPC.md`.
- Golden loop: use isolated examples (`shot1_acceptance`, `stage2_golden_loop`, or newer successors) rather than the reader's real database.
- AI model and pricing constants are implementation defaults, not timeless claims. Re-verify with provider docs before publishing pricing/current-model copy.
- Consent surfaces are REAL modals: `CloudConsentSheet` portals to `document.body` (it must never render inside the margin rail's transformed/animated/inert subtree), and the Playwright `cloud-consent-gate` / `cloud-consent-gate-deep-study` tests prove top-most, hit-testable placement — not mere DOM visibility — for both the passage lenses and Deep Study's first-cloud briefing.

## Dependency advisory posture (2026-08-30)

Auditing is a **blocking gate**, not advice (`ci.yml`; source-pinned in `src/releasePipeline.test.ts`):

- **Production npm tree** (`npm audit --omit=dev --audit-level=low`): blocking at every severity. Clean as of this reconciliation.
- **Release toolchain** (`scripts/audit-release-tool.mjs` — the `wrangler` and `@tauri-apps/cli` subtrees, which run with publication credentials): blocking at every severity. Clean after pinning wrangler 4.127.1 (the 4.110.0 pin carried the miniflare/sharp/undici advisory chain).
- **RustSec** (`cargo audit --deny unsound --deny yanked` over `src-tauri/Cargo.lock`): blocking. Zero vulnerabilities after the 2026-08-30 refresh (anyhow 1.0.104, plist 1.10.0 → quick-xml 0.41.0, quinn-proto 0.11.17, serde_with 3.22.0, event-listener 5.4.2, Tauri 2.11.5 patch chain). The gate's ONLY exception is `RUSTSEC-2024-0429` (glib, unsound), documented with reason + revisit condition in `src-tauri/.cargo/audit.toml`: glib 0.18 is pinned by Tauri 2's Linux GTK3 stack and is compiled into no macOS artifact.
- **Accepted, non-gating warnings** (re-check on every Tauri upgrade): the gtk-rs GTK3 bindings are unmaintained (`RUSTSEC-2024-0411..0420`, plus `proc-macro-error` `RUSTSEC-2024-0370`) — Linux-only, never shipped; the `unic-*` crates are unmaintained (`RUSTSEC-2025-0075/0080/0081/0098/0100`, via `urlpattern` ← `tauri-utils`) — compiled on macOS but carrying no vulnerability, pinned by Tauri 2. The residual dev-only npm tree keeps a non-blocking `npm audit --audit-level=high` step (clean as of this reconciliation).

## Prior review packets

- `docs/REVIEW-2026-06-09.md` captured pre-0.6 launch risks, including missing audit index, export-root drift, and API-version history drift.
- `docs/REVIEW-2026-06-10.md` captured the later field-test sweep. Several launch blockers from that packet have since been fixed in code, including the window drag permission, release `releaseDraft: false`, default export root, bundled Discover search, and company-relay/cap handling.
- `docs/v1.1-gaps.md` is the 2026-06-07 persona backlog; its status header records what has shipped as of v0.9.3 and what remains open.

## Standing reminders

- Run the full golden-loop and test gates after any launch-readiness patch.
- Keep docs and product copy aligned with the paid/source build split: Throughline AI is a remote relay in the signed build; Local means loopback-only; source users may choose BYO keys, Codex/ChatGPT login, Local, or no AI.
- When a dependency bump is impossible without a major migration, the exception goes in `src-tauri/.cargo/audit.toml` (Rust) with its reason and revisit condition — never a silenced or deleted gate.

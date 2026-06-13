# Throughline Audit Index

Last reconciled: 2026-06-12.

This file exists because `CLAUDE.md` asks agents to reconcile against `docs/AUDIT.md` after their own sweep. Treat this as the current audit index; older review files remain useful evidence, but the shipped code and `CLAUDE.md` are authoritative when they disagree.

## Current launch-readiness checks

- Product promise docs: `README.md`, `docs/IPC.md`, and `docs/AI_PROVIDERS.md` should describe the current Throughline shape: Today-first, sitting-based progress, `~/Documents/Throughline` exports, bundled offline Discover search, paid Throughline AI activation, BYO/local AI, and no forced first-run AI chooser.
- IPC surface: every command registered in `src-tauri/src/lib.rs` should have a `#### cmd_*` entry in `docs/IPC.md`.
- Golden loop: use isolated examples (`shot1_acceptance`, `stage2_golden_loop`, or newer successors) rather than the reader's real database.
- AI model and pricing constants are implementation defaults, not timeless claims. Re-verify with provider docs before publishing pricing/current-model copy.

## Prior review packets

- `docs/REVIEW-2026-06-09.md` captured pre-0.6 launch risks, including missing audit index, export-root drift, and API-version history drift.
- `docs/REVIEW-2026-06-10.md` captured the later field-test sweep. Several launch blockers from that packet have since been fixed in code, including the window drag permission, release `releaseDraft: false`, default export root, bundled Discover search, and company-relay/cap handling.

## Standing reminders

- Run the full golden-loop and test gates after any launch-readiness patch.
- Keep docs and product copy aligned with the paid/source build split: Throughline AI is a remote relay in the signed build; Local means loopback-only; source users may choose BYO keys, Codex/ChatGPT login, Local, or no AI.

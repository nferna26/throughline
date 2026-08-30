# Contributing to Throughline

Throughline is a local-first macOS reading app. Before contributing, read
[`CLAUDE.md`](./CLAUDE.md) — it's the binding product contract. When there's
tension between "what would be cool to build" and "what we agreed to build,"
CLAUDE.md wins.

## The non-goals are load-bearing

Throughline deliberately does **not** have: cloud sync, accounts, telemetry,
background agents, gamification (XP / badges / punitive streaks), quizzes /
spaced repetition, a library-first or dashboard-first UI, or remote AI by
default. PRs that add these will be declined, however well-built. The product's
value is in what it refuses to do. See the full list in `CLAUDE.md`.

## Development setup

Prereqs: Node 20+ (Node 22+ to run the release tooling — the exact-pinned
`wrangler` declares `engines.node >= 22`), Rust + Cargo, Xcode Command Line
Tools, macOS.

```bash
git clone https://github.com/nferna26/throughline
cd throughline
npm install
npm run tauri dev
```

The AI tutor needs a local OpenAI-compatible server (LM Studio, llama.cpp, or
any MLX server) listening on `http://localhost:1234/v1`. It's optional — the
rest of the app works without it.

## Before you open a PR

CI (`.github/workflows/ci.yml`, required on PRs to `main`) runs the gates
below on macOS — run them locally first; CI will reject a red build:

```bash
npm run version:check                      # tauri.conf / package.json / Cargo.toml agree
npm run typecheck                          # tsc --noEmit
npm run build                              # vite production build
npm test                                   # Vitest (frontend + pipeline-invariant suites)
npx playwright test                        # UI walkthrough + a11y (real frontend, faked IPC)
cd src-tauri
cargo test --all-targets                   # Rust unit + integration tests
cargo run --example stage2_golden_loop     # the golden loop, isolated data dir
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

Dependency advisories **block** CI too (see `docs/AUDIT.md`):

```bash
npm audit --omit=dev --audit-level=low     # production deps: any advisory is red
node scripts/audit-release-tool.mjs        # wrangler + @tauri-apps/cli subtrees
cd src-tauri && cargo audit --deny unsound --deny yanked   # RustSec gate
```

The Python plain-language eval harness is a required gate as well
(`eval/plain-language/`): `python -m pytest tests/ -q && python verify_gate.py`
reproduces the committed-fixture result with no model calls.

## Architecture map

- **Backend** (`src-tauri/src/`): `lib.rs` wires everything; commands live in
  `commands/{ai,backups,books,discover,feedback,notes,plans,sessions,settings_cmds}.rs`
  (+ `db_helpers.rs`). Primitives: `db.rs`, `migrations.rs`, `paths.rs`,
  `error.rs`, `log.rs`, `keystore.rs`. Feature logic: `import.rs` /
  `import_epub.rs` / `epub_classify.rs` / `gutenberg_markup.rs` (ingest),
  `book_structure.rs`, `chunker.rs`, `plan.rs`, `sittings.rs`, `phrases.rs`,
  `ai_client.rs` / `ai_providers.rs` / `ai_stub.rs` / `ai_retention.rs`,
  `circuit_breaker.rs`, `backup.rs`, `export.rs`, `settings.rs`,
  `relaunch_focus.rs`.
- **Frontend** (`src/`): `App.tsx` routes between `screens/` (`FrontDoor`,
  `Today`, `TextReader`, `Library`, `Discover`, `NotesBrowser`,
  `BookSwitcher`, `BookSetupSheet`, `Settings`). The Companion Margin lives in
  `components/` (`MarginTutorCard`, `MarginNoteCard`, `SectionBriefingCard`,
  `CloudConsentSheet` — a portaled real modal, `AiSetupSheet`). Shared modal
  accessibility in `hooks/useDialog.ts`.
- **IPC contract**: [`docs/IPC.md`](./docs/IPC.md). Changing a command's args or
  return shape is a breaking change — bump `COMMAND_API_VERSION` and note it in
  the CHANGELOG.

## Conventions

- **Database safety**: any new program under `src-tauri/examples/` MUST call
  `bin_guardrail::init_isolated_data_dir(...)` or be added to the
  `REAL_DB_ALLOWLIST` in `lib.rs`. A test enforces this. Tests never touch the
  user's real DB (a `cfg(test)` guard in `paths::app_support_dir` enforces it).
- **Errors**: commands return `Result<T, AppError>`. Classify errors with the
  right variant (`Validation` / `NotFound` / `Ai` / etc.), not `Internal`,
  where the context is clear.
- **AI calls**: any new path that reaches the network MUST route through
  `ai_client::validate_base_url` so the local-only invariant can't be bypassed.
  `tauri-plugin-http` / `tauri-plugin-shell` are banned (a test enforces this).
- **Dependencies**: new dependencies are ask-first (`CLAUDE.md`), and every
  dependency change must leave the blocking audits green — production npm
  tree, release-tool subtrees, and the RustSec gate. Exceptions live only in
  `src-tauri/.cargo/audit.toml`, each with a written reason and revisit
  condition.
- **Exports**: write through `paths::atomic_write_string`. Never `fs::write`
  user-facing artifacts directly.

## Reporting bugs

Use the issue templates. Include macOS version, what you did, what you expected,
and what happened. If the app misbehaved, the local log at
`~/Library/Application Support/Throughline/logs/app.log` often has the answer —
attach the relevant lines (it contains no secrets, but skim before pasting).

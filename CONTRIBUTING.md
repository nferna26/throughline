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

Prereqs: Node 20+, Rust + Cargo, Xcode Command Line Tools, macOS.

```bash
git clone https://github.com/nferna26/Throughline
cd Throughline
npm install
npm run tauri dev
```

The AI tutor needs a local OpenAI-compatible server (LM Studio, llama.cpp, or
any MLX server) listening on `http://localhost:1234/v1`. It's optional — the
rest of the app works without it.

## Before you open a PR

Run the full check locally — CI runs the same on macOS:

```bash
npm run typecheck                          # tsc --noEmit
npm run build                              # vite production build
cd src-tauri && cargo test --all-targets   # 71 unit + 2 integration tests
```

All three must pass. CI will reject a red build.

## Architecture map

- **Backend** (`src-tauri/src/`): `lib.rs` wires everything; commands live in
  `commands/{books,sessions,notes,ai,settings_cmds}.rs`. Primitives:
  `db.rs`, `migrations.rs`, `paths.rs`, `error.rs`, `log.rs`. Feature logic:
  `import*.rs`, `epub_classify.rs`, `plan.rs`, `recovery.rs`, `ai_stub.rs`,
  `ai_client.rs`, `circuit_breaker.rs`, `export.rs`, `settings.rs`.
- **Frontend** (`src/`): `App.tsx` routes between `screens/{Today,Reader,Settings}`.
  Reader splits into `TextReader` / `EpubReader`. Shared modal accessibility in
  `hooks/useDialog.ts`.
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
- **Exports**: write through `paths::atomic_write_string`. Never `fs::write`
  user-facing artifacts directly.

## Reporting bugs

Use the issue templates. Include macOS version, what you did, what you expected,
and what happened. If the app misbehaved, the local log at
`~/Library/Application Support/Throughline/logs/app.log` often has the answer —
attach the relevant lines (it contains no secrets, but skim before pasting).

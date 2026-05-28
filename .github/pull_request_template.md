## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The job / bug this addresses. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `cd src-tauri && cargo test --all-targets` passes
- [ ] Doesn't violate the non-goals in [CLAUDE.md](../blob/main/CLAUDE.md)
- [ ] If a command's args/return shape changed: bumped `COMMAND_API_VERSION` and updated `docs/IPC.md` + CHANGELOG
- [ ] If a new `examples/` program: it calls `init_isolated_data_dir` or is on the `REAL_DB_ALLOWLIST`
- [ ] If it reaches the network: routed through `ai_client::validate_base_url`

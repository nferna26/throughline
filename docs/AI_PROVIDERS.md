# AI providers (Local + OpenAI + Anthropic + Codex)

Throughline's tutor and Deep Study briefing can run **on-device** (LM Studio) or
through a **cloud provider you control**. The choice is explicit — there is no
implicit remote default — and every cloud provider shows a "your selected text
goes to X" disclosure before any call.

## The contract (unchanged guarantees)

- **You choose, per install.** A forced first-run onboarding step picks the
  provider (Local / OpenAI / Anthropic / Codex / None). Editable anytime in
  Settings → Assistance. `ai_provider` is authoritative.
- **Only the selection is ever sent** — a passage (tutor) or a section (Deep
  Study), never the whole book. Raw source files still never leave the device.
- **Reader-initiated only.** No background, timer, or on-launch AI.
- **Keys live in the macOS Keychain** (`keystore.rs`), never in the DB, a file,
  the repo, logs, or exports. Commands expose only `ai_key_present_*` booleans.
- **The UI never falsely claims "local".** A cloud call shows a "via &lt;Provider&gt;"
  badge; the trust summary flips to "remote" and names the provider.

## How each provider works (backend `ai_providers.rs`)

| Provider | Endpoint | Auth | Notes |
|---|---|---|---|
| **Local** | `{base}/chat/completions` (loopback only) | none | Unchanged LM Studio path; hard loopback backstop via `validate_base_url`. |
| **OpenAI** | `api.openai.com/v1/chat/completions` | `Authorization: Bearer <key>` | Reuses the OpenAI-compatible client. GPT-5.x needs `max_completion_tokens` (not `max_tokens`) and `reasoning_effort: "none"` (concise answers; `"minimal"` is unsupported on gpt-5.5). Best model auto-selected from `GET /v1/models`. |
| **Anthropic** | `api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | New named-event SSE state machine (`content_block_delta`/`text_delta` → text, `message_stop` → done, `error` event → fatal). `max_tokens` required; top-level `system`. Default `claude-opus-4-8`. |
| **Codex** | `chatgpt.com/backend-api/codex/responses` | `Bearer <access_token>` + `ChatGPT-Account-ID` + `originator: codex_cli_rs` | **App-owned device-code login** (preferred) or the Codex CLI's `~/.codex/auth.json` (fallback); **no shell-out, no OpenClaw**. Reactive 401-refresh via `auth.openai.com/oauth/token` (public client `app_EMoamEEZ73f0CkXaXp7hrann`). Responses API body requires `instructions` + a message-list `input`. |

### Codex: app-owned device-code login

"Sign in with ChatGPT" (onboarding + Settings → Assistance) runs OpenAI's device
flow so Throughline keeps its **own** Codex credentials in the Keychain — decoupled
from the Codex CLI's file (survives Codex moving creds to the OS keyring; no
shared-file refresh conflict). Steps, from the official `openai/codex` source:

1. `POST auth.openai.com/api/accounts/deviceauth/usercode` `{client_id}` →
   `{device_auth_id, user_code, interval}` (interval is a **string**).
2. Show `auth.openai.com/codex/device` + `user_code`; poll
   `POST .../deviceauth/token` `{device_auth_id, user_code}` (403/404 = pending) →
   `{authorization_code, code_verifier}`.
3. Form-`POST auth.openai.com/oauth/token`
   `grant_type=authorization_code&code&redirect_uri&client_id&code_verifier` →
   `{id_token, access_token, refresh_token}`.
4. Decode `id_token` for `chatgpt_account_id`; store `{access_token, refresh_token,
   account_id}` in the Keychain (`cmd_codex_device_start`/`_poll`/`_logout`).

`load_codex()` prefers the app-owned Keychain creds over the file; a refresh
writes back to whichever store the creds came from. **Verified end-to-end live**
(device approval → poll → exchange → app-owned Codex call returned a streamed
reply). The optional api-key token-exchange is skipped — the Responses path uses
the access token directly.

All four normalize into the existing `StreamEvent` Delta/Done/Error channel, so
the reader cards are unchanged.

## Settings (KV) + commands

- `ai_provider` (`local|openai|anthropic|codex|none`), `ai_provider_chosen_at`
  (onboarding-complete flag), per-provider models (`ai_model`, `ai_model_openai`,
  `ai_model_anthropic`, `ai_model_codex`). Cloud base URLs are **code constants**
  (a typo can't redirect a key); the `ai_base_url` slot is loopback-only.
- `cmd_set_ai_settings(provider?, baseUrl?, model?, retentionDays?)`,
  `cmd_set_ai_key(provider, key)`, `cmd_clear_ai_key(provider)`,
  `cmd_test_ai_connection(provider?, key?)`, `cmd_list_ai_models(provider?)`.
  `COMMAND_API_VERSION` bumped 2 → 3.

## Live verification (ignore-gated; never in CI)

`src-tauri/src/ai_providers.rs` has `live_openai` / `live_anthropic` / `live_codex`
behind `#[ignore]`. They read `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from env and
`~/.codex` for Codex, and never print the secret. Run e.g.:

```
cargo test --lib -- --ignored live_anthropic --nocapture
```

**All three verified live** (each streamed a one-word reply end-to-end):
OpenAI `gpt-5.5`, Anthropic `claude-opus-4-8`, Codex via `codex login` (`gpt-5.5`).

## Known fragility

- **Codex** reuses an unofficial contract (client id, the `chatgpt.com/backend-api/codex`
  base, headers, the Responses schema). OpenAI can change these; on failure the
  app degrades to a clear "run `codex login`" message. The app never proactively
  background-refreshes the shared `auth.json` (consistent with no-background-AI).
- **`keyring`** is the one new dependency. A locked Keychain or a changed signing
  identity degrades to `key_present = false` with a re-enter-key message; it never
  crashes, and CI uses an in-memory backend.

# Phrases API — relay contract v1

**Status: FROZEN at first post (2026-06-11).** The app session builds against this
document via a local mock; the relay session (throughline-ai-proxy repo) implements
it verbatim. Any change after first post is surfaced explicitly to the operator —
it is the one thing the standing Stage-3 authorization requires surfacing.

## What this is

Evocative session names ("the pear tree and the gang") for the Today screen's
phrase slot. The app sends each sitting's **chapter label + opening slice**; the
relay returns a short phrase per item. Phrases are decorative and additive:
every failure mode must be invisible — the heuristic `chapter_label` simply
keeps carrying the screen.

Conventions follow the existing relay endpoints (`/v1/tutor`, `/v1/credits`):
path-based versioning, lowercase `authorization: Bearer <license>` header,
fractions-and-questions metering (dollar amounts never reach the client),
no-content-in-diagnostics on both sides.

## Endpoint

```
POST {base}/v1/phrases
authorization: Bearer <license>      ← the activation license from /v1/activate
content-type: application/json
```

`{base}` defaults to `https://ai.readthroughline.com` (the app's
`company_base_url` setting). There is no version header; the path is the version.
Company builds only — BYO-key/local builds never call the relay (see §Builds).

## Request

```json
{
  "version": 1,
  "items": [
    {
      "opening_hash": "64 lowercase hex chars (sha-256)",
      "label": "Chapter II",
      "slice": "Begin the morning by saying to thyself…"
    }
  ]
}
```

Hard caps (the relay rejects, the app never exceeds):

| Field | Cap | Notes |
|---|---|---|
| `items` | **120 per call** | larger batches are split by the app |
| `slice` | **1,800 chars** | matches `sittings::OPENING_CHARS` exactly |
| `label` | 120 chars | the heuristic chapter label, for context only |

**Derivation contract (protocol-locked).** `slice` and `opening_hash` derive
from the *same normalized bytes* of the sitting's text:

1. `normalized = sitting_text` with all whitespace runs collapsed to single
   spaces and trimmed (`split_whitespace().join(" ")`).
2. `opening_hash = sha256_hex(utf8_bytes(first 1,800 chars of normalized))` —
   chars are Unicode scalar values, not bytes. This is `sittings::opening_hash`
   and must match the relay's KV cache key exactly.
3. `slice = first ~300 words of normalized, never exceeding 1,800 chars` — a
   prefix of the exact string hashed in (2).

The slice is a prefix of the sitting's own text and nothing else — spoiler
safety is by construction, not by prompt. The relay treats `opening_hash` as an
opaque, content-addressed cache key (global: the same opening yields the same
phrase for everyone; no user or book linkage is stored with it).

`400` is returned for cap violations, malformed hashes, or empty items — the
app treats any `400` as a permanent skip for that batch (log only).

## Response — 200

```json
{
  "version": 1,
  "items": [
    { "opening_hash": "…", "phrase": "the morning resolve at the day's door" }
  ],
  "usage": { "input_tokens": 1840, "output_tokens": 96 },
  "remaining": {
    "status": "active",
    "remaining_fraction": 0.71,
    "approx_questions_left": 284
  }
}
```

- `items` may be **partial** (the relay omits items it could not phrase) and
  may be served from cache. Cached items SHOULD NOT decrement the allowance.
- `remaining` mirrors `/v1/credits` exactly (`status`:
  `active | exhausted | expired | revoked | uninit | unknown`; fraction clamped
  0–1; questions are approximate). The app may cache it for display; it never
  computes dollars.
- Phrase constraints the relay enforces before returning an item (the app
  re-validates and silently drops violators, keeping the heuristic for that
  item only): 1–10 words, ≤ 80 chars, single line, drawn from the slice's
  world only (no spoilers past the slice, no invented names), no surrounding
  quotes, no terminal period, **no em dashes** (house rule), sentence case
  (lowercase unless a proper noun leads).

## Errors

| Status | Body | App behavior |
|---|---|---|
| `401` | `{ "error": "invalid_license" }` | permanent stop until re-activation; log only |
| `402` | `{ "error": "cap_hit" }` | **distinct state**: long cool-down (24 h). Phrases NEVER surface cap UI — the three-door cap screen stays tutor-only |
| `429` | `{ "error": "rate_limited", "retry_after": 30 }` + `Retry-After` header | back off ≥ `retry_after` seconds, with jitter |
| `5xx` / transport | — | exponential backoff + jitter (1 min → 5 min → 30 min cap) |

Failure invisibility is a hard invariant: offline, 429, cap-hit, and
relay-down are visually indistinguishable from heuristic mode. No user-facing
errors for phrases, ever; the app logs counts and statuses, never slice text
(no-content-in-diagnostics, both sides). The relay must not log, persist, or
index slice text beyond the content-addressed phrase cache itself.

Idempotency: the request is content-addressed and side-effect-free; the app may
retry any batch after backoff without double-spend (cached hashes are free).

## Auth & metering

- The license is the Keychain-held activation license (`keystore` account
  `ai_key_company`) — the same credential `/v1/tutor` uses. No other secret.
- Metering counts tokens server-side and reports **fractions and approximate
  questions only**, consistent with the existing posture: usage, never content;
  questions, never dollars. Phrase batches are expected to be a rounding error
  next to tutor usage; the relay may meter them at a discounted weight (its
  call — the contract only fixes the response shape).

## Builds

- **Company build**: this endpoint, with the license.
- **BYO-key / local (OSS) build**: the relay is never called and no relay key
  exists in the build. The app runs the *identical* flow — same payload
  builder, same caps, same validation, same invisibility — through the user's
  configured provider (Anthropic/OpenAI key, or the loopback local model),
  using the generation contract below. The Settings AI-phrases toggle gates
  both paths; off = zero phrase network calls of any kind.

## Appendix: generation contract (relay-side prompt, shared with BYO)

So relay and BYO outputs match, both use this EXACT instruction string (model:
relay = its locked Sonnet default; BYO = the user's chosen model). The bytes
below are the app's `phrases::GEN_INSTRUCTION` verbatim — pure ASCII on
purpose, so the prompt never carries the punctuation it bans:

```
You name reading sessions for a literary reading app. For each item, read the chapter label and the opening slice, and return a short evocative phrase (1-10 words) naming what the reader is about to meet, drawn only from what the slice itself shows, never beyond it. No spoilers, no invented names, no quotes, no em dashes, no terminal period, sentence case. Return STRICT JSON: [{"opening_hash": "...", "phrase": "..."}] with one entry per input item, in order; omit an item rather than guess.
```

Temperature low (≤ 0.3); max output tokens ≈ 24 × items. A response that fails
strict-JSON parsing is dropped whole (log only) — never partially trusted.

*Amendment 2026-06-11 (surfaced per the freeze rule): the appendix prompt was
restated as the implementation's exact ASCII bytes; the first posting's prose
used typographic dashes the app side never shipped. No wire-shape change.*

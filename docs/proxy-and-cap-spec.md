# Throughline — Company-Paid AI: Proxy + Cap Spec

> Status: **design** (counsel-approved posture; Anthropic bundling confirmed by email 2026-06).
> Implements the locked decision: **$20 one-time → bundled Claude Sonnet via a company
> account, with a ~1,500-call / 24-month credit cap, then graceful fallback to BYO-key /
> local.** Not a subscription. See `founder-kb` decisions *throughline-pricing-and-product-strategy*
> and *throughline-ai-copyright-safety*.

This spec is the basis for the eventual `/goal`. It deliberately mirrors the in-app
pieces already shipped (the `company` provider slots into the existing AI dispatch; the
B6 usage parsing and C2 consent gate already exist client-side).

---

## 1. Goal & non-negotiable constraints

**Goal.** A reader pays $20 once and the AI tutor "just works" — no API key, no account —
until they hit a generous cap, after which the app calmly offers BYO-key / local.

**Binding constraints (counsel — `throughline-ai-copyright-safety`):**
1. The proxy is a **stateless forwarder**: forward → stream back → **drop**. It NEVER
   logs, persists, indexes, disk-caches, or summarizes request/response **bodies** (the
   reader's passage or the model's answer).
2. **Meter tokens, not content.** The only per-call data persisted is counts + metadata
   (token counts, timestamps, status) — never the prompt or book text.
3. Reader-initiated, **selection-scoped** only. The proxy enforces the same lens-shaped,
   selection-only request contract server-side — it is **not** a general Anthropic
   passthrough (a leaked token can't be used as free general Claude).
4. **No accounts, no passwords.** A per-install license token *is* the identity.
5. Local-first is preserved: an outage of the proxy only pauses the *optional* tutor;
   reading, notes, and export are untouched.

---

## 2. Architecture (data flow)

```
  Throughline app (macOS)                 Company edge (Cloudflare Workers)            Anthropic
  ─────────────────────                   ─────────────────────────────────           ─────────
  cmd_ai_ask                              POST /v1/tutor  (license token auth)
   └ provider = "company"   ──────────▶   1. verify token + cap (Durable Object)
     base_url = proxy URL                 2. validate lens-shaped request shape
     auth = license token                 3. attach COMPANY Anthropic key
                                          4. forward  ──────────────────────────▶  /v1/messages (stream)
        stream SSE  ◀──────────────────   5. relay SSE deltas verbatim   ◀──────────  deltas + usage
                                          6. read the usage block, increment counter
                                          7. drop bodies; persist counts only
   B6 usage capture (client)              ── no body logging, ever ──
```

- In **company mode** the app's AI provider points at the proxy. The proxy speaks the
  protocol the client already streams (Anthropic-style SSE), so `run_provider_call` needs
  only a new `Company` arm whose host is the proxy + whose auth header is the license token.
- Stripe Checkout (one-time $20) → webhook mints a license token → delivered to the app.

---

## 3. Components

### 3.1 Edge proxy — Cloudflare Workers (recommended)
Why Workers: global, cheap (~$5/mo Paid), first-class SSE streaming, env secrets for the
Anthropic key, Durable Objects for an atomic per-token counter. (Alternatives: Fly.io +
Axum for more control; Vercel AI Gateway as a zero-retention forwarding layer — but the
cap/license/Stripe logic is custom either way, so a thin Worker is the simplest whole.)

Responsibilities, in order, per request:
1. **Auth** — read the license token (Authorization: Bearer …); look up its Durable Object.
2. **Cap check** — reject with `cap_exhausted` if calls ≥ limit OR now > expiry OR status ≠ active.
3. **Shape check** — accept only the tutor contract: a known lens (explain/context/define/
   socratic/section-briefing), Sonnet 4.6 only, `max_tokens` ≤ the tier ceiling, a single
   user turn. Reject anything else (this is both abuse control and the copyright fence).
4. **Forward** — attach the company `x-api-key`, stream Anthropic's SSE back **verbatim**.
5. **Meter** — parse the `message_start`/`message_delta` usage blocks (the same fields the
   client already parses in B6), increment `tokens_used` and `calls_used` once at stream end.
6. **Drop** — never write the prompt or completion anywhere. Access logs strip bodies.

### 3.2 License + cap store
- **D1 (SQLite)** `licenses` table: `token_hash, stripe_session_id, issued_at, expires_at,
  calls_limit, tokens_limit, status (active|revoked|exhausted), created_at`. (Store a *hash*
  of the token, not the token.)
- **Durable Object per license** for the live counter (`calls_used`, `tokens_used`) —
  gives atomic increments under concurrent calls without D1 write races. The DO is the
  source of truth for "remaining"; D1 holds the durable record + admin queries.

### 3.3 Stripe
- **Checkout** (one-time $20, no subscription). A Worker route creates the session.
- **Webhook** `checkout.session.completed` → generate a random opaque token (32 bytes,
  base64url) → write the D1 row (token hash + caps + 24-month expiry) → deliver the token.
- **Delivery** — two paths, app prefers the deep link: (a) success redirect to
  `throughline://activate?token=…` (custom URL scheme the app registers), with (b) a
  short activation code shown on the Stripe success page + in the receipt email as a
  fallback for re-activation on another Mac.

### 3.4 Client (Throughline app) — grounded in current code
- New provider value `company` alongside local/openai/anthropic/codex.
- Activation: Settings → "Turn on Throughline AI ($20)" → opens Stripe Checkout in the
  system browser → app receives the token (deep link or pasted code) → stores it in the
  **Keychain** (like `cmd_set_ai_key`) → sets provider=company, model=`claude-sonnet-4-6`
  (locked; the B2 picker is hidden in company mode).
- `run_provider_call` gains a `Company` arm: base_url = proxy, auth = the license token.
  The existing C2 consent gate and B6 usage capture work unchanged (the proxy streams the
  same SSE incl. usage).
- **Cap-exhausted handling** — a new `CapExhausted` error (mirrors `NeedsCloudConsent`):
  the app shows a calm sheet — "You've used your Throughline AI credits. Keep going with
  your own API key, or switch to a local model — your plan and notes are untouched." →
  routes to the existing BYO-key / local setup.

---

## 4. The cap (the heart of the economics)

- **Units.** Primary budget is a **token budget** (truer to COGS than raw calls), surfaced
  to the reader as "tutor credits" with an approximate call estimate. A **call count**
  (≤ ~1,500) is a secondary guard so a few pathological calls can't drain it. **24-month
  expiry** regardless. Whichever limit hits first → exhausted.
  - Sizing: the decision's "~1,500 mid calls" ≈ a token budget set so worst-case AI COGS
    stays under ~$16.50 (≈ the cap that keeps the $20 one-time above water). Pin the exact
    number from the **real B6 usage data** before launch — don't guess.
- **Enforced server-side only.** The client may *display* remaining credits (a read-only
  `GET /v1/credits`), but never decides eligibility. The Durable Object is authoritative.
- **Graceful fallback.** On exhaustion the app does not dead-end: BYO-key or local, one tap.

---

## 5. Abuse / fraud controls
- **Per-token rate limit** (e.g. 60 req/min) in the Worker — slows a leaked token.
- **Shape lock** (§3.1.3) — a leaked token can only run selection-scoped tutor calls on
  Sonnet, never arbitrary prompts; this caps the blast radius of a leak to one license's cap.
- **Anomaly alert** — any token > N calls/day emails the founder (Resend).
- **Revocation** — `status = revoked` → instant cutoff; used for refunds/chargebacks.
- **Key hygiene** — the company Anthropic key is a Worker secret, rotated quarterly.
- **Portability tradeoff (decided):** the token is portable across the buyer's Macs (no
  accounts); the cap is *shared* across them, which is self-limiting and acceptable.

---

## 6. Failure modes
| Failure | Behaviour |
|---|---|
| Proxy down | App shows a calm retry + offers BYO/local. Reading/notes unaffected. |
| Anthropic down | Proxy relays the upstream error; app surfaces it. |
| Cap exhausted | `cap_exhausted` → fallback sheet (BYO/local). |
| Token revoked | Fallback sheet + "contact support". |
| Stripe webhook lost | Idempotent mint keyed on `session_id`; a re-activation endpoint re-issues from a paid session. |

---

## 7. Unit economics (recap, from the research memo)
- Revenue: **$19.12 net/sale** ($20 − Stripe 2.9% + $0.30).
- AI COGS: **~$2.40** mid-band lifetime, capped at **~$16.50** worst case (Sonnet $3/$15 per Mtok).
- Infra: **~$30–60/mo fixed** (Workers + D1 + Resend) + ~$0.20/user/yr variable.
- Margin: **~88%** for the mid reader; the cap guarantees a positive floor.

---

## 8. Build plan (sequenced; ~6–10 eng-weeks total)
1. **Proxy core** — Worker: token auth (stub store) → shape-check → forward Sonnet → stream
   SSE → meter usage → drop bodies. (The riskiest correctness work: streaming + metering.)
2. **License + cap store** — D1 schema + Durable Object counter + `cap_exhausted` response
   + `GET /v1/credits`.
3. **Stripe** — Checkout route + webhook + token mint + delivery (deep link + code).
4. **Client company mode** — provider arm, Keychain token, activation UI, locked Sonnet,
   `CapExhausted` fallback sheet. Self-verify via the harness (a fake `company` provider +
   the activation + cap-exhausted states).
5. **Abuse + ops** — rate limit, anomaly alerts, revocation, key rotation, a one-page runbook.

Each phase is independently shippable; phases 1–2 can be exercised end-to-end with a test
token before Stripe exists.

---

## 9. Open decisions (need a call before building)
1. **Token delivery** — deep link (`throughline://activate`) as primary, activation code as
   fallback? (Recommended.) Registering a custom URL scheme on macOS is a small Tauri config.
2. **Counter primitive** — Durable Object per license (recommended, atomic) vs a D1
   transaction (simpler, slight race risk).
3. **Cap surfacing** — show "credits remaining" in Settings (read-only `GET /v1/credits`),
   or stay silent until near-exhaustion? (Recommended: a quiet "credits" line in the usage
   card, reusing the B4 panel.)
4. **Existing usage data** — pin the exact token/call cap from 30–60 days of real B6 usage
   before launch, rather than the placeholder 1,500.
5. **Domain / hosting account** — which Cloudflare account + which subdomain
   (e.g. `ai.throughline.app`).

---

## 10. What's already in place (reused, not rebuilt)
- **B6 usage parsing** (`accumulate_anthropic_usage`, the usage block fields) — the same
  parse the proxy needs server-side.
- **B4 usage panel + `ai_request_usage`** — the client-side spend view; "credits remaining"
  slots into it.
- **C2 consent gate** (`NeedsCloudConsent`) — the pattern the `CapExhausted` fallback copies.
- **B1/B2 model handling** — Sonnet default + the picker that company mode hides.
- The AI provider dispatch (`run_provider_call`) — a `Company` arm is the only new path.

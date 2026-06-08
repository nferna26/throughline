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

**Posture (locked).** Company AI is the **front door**; BYO-key / local is the **floor** a
capped reader degrades *to* — never removed. A capped user with no fallback is a refund +
a one-star review; a capped user who pastes their own key or runs local is the local-first
heritage doing exactly the job it was built for.

**Reversibility is the whole design.** Every tunable — the cap value, the per-install
counter, the endpoint — lives **server-side** behind the subdomain. Nothing that can break
or needs tuning is compiled into the client, so the bet launches with zero prior data and
every knob moves without an app update.

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

### 3.1 Edge proxy — Cloudflare Worker + AI Gateway
Why Workers: global, cheap (~$5/mo Paid), first-class SSE streaming, env secrets for the
Anthropic key, Durable Objects for a strongly-consistent per-install counter.

**Put Cloudflare AI Gateway between the Worker and Anthropic.** It gives provider-side
rate limiting, optional response caching, and analytics out of the box — purpose-built for
this, and already in our Cloudflare stack, so it's a force-multiplier not a new dependency.
The Worker still owns license validation + the cap + auth; AI Gateway absorbs observability
and provider rate-limit burden. (Alternatives if ever needed: Fly.io + Axum.)

Responsibilities, in order, per request:
1. **Auth** — read the license token (Authorization: Bearer …); look up its Durable Object.
2. **Cap check** — reject with `cap_exhausted` if cost-budget spent OR now > expiry OR status ≠ active.
3. **Shape check** — accept only the tutor contract: a known lens (explain/context/define/
   socratic/section-briefing), Sonnet 4.6 only, `max_tokens` ≤ the tier ceiling, a single
   user turn. Reject anything else (this is both abuse control and the copyright fence).
4. **Forward** — attach the company key (via AI Gateway), and **pipe the SSE end-to-end with a
   `TransformStream` — never `await response.text()`** — so deltas still appear live in the
   margin (our `mock_server_streams_deltas_to_client` test pins delta streaming). The Workers
   CPU limit doesn't count time *waiting* on the Anthropic subrequest, only compute, and
   piping bytes is cheap — a 60s completion is fine. (Confirm current limits in CF docs.)
5. **Meter** — read Anthropic's `usage` block from the stream (the same B6 fields), compute
   real `cost_usd_micros`, and debit the Durable Object once at stream end. No estimation at
   debit time.
6. **Drop** — never write the prompt or completion anywhere. Access logs strip bodies.

### 3.2 License + cap store
- **D1 (SQLite)** `licenses` table: `token_hash, stripe_session_id, issued_at, expires_at,
  budget_micros (the cost ceiling), status (active|revoked|exhausted), created_at`. (Store a
  *hash* of the token, not the token.)
- **Durable Object per license** for the live counter (`spent_micros`, `calls_used`, last-N
  costs for the display estimate). **DO, not bare KV:** KV is eventually consistent, so two
  concurrent calls can both read a stale balance and both slip through — fine for approximate
  heavy-tail protection, but a DO is strongly consistent + single-threaded per install, which
  is what makes the cap a *true* ceiling. One DO per license. D1 holds the durable record +
  admin queries; the DO is the source of truth for "remaining."

### 3.3 Stripe
- **Checkout** (one-time $20, no subscription). A Worker route creates the session.
- **Webhook** `checkout.session.completed` → write the D1 license row (budget + 24-month
  expiry, no token yet) → generate a **single-use, short-TTL activation token** bound to it.
- **Delivery — two paths, both mandatory.** The thing that travels in a URL / shows on the
  success page lands in browser history, so it must be an **activation token, never the
  durable license**: single-use, short-TTL, useless after first claim and to anyone but the
  first claimer. The app `POST`s it to `/v1/activate`, which mints the **durable per-install
  HMAC license** and returns it (stored in Keychain). The durable secret never travels in a URL.
  - (a) **Deep link** — success redirect to `throughline://activate?token=<activation>`.
  - (b) **Typed code** — `XXXX-XXXX-XXXX` Crockford base32 (no I/O/1/0; case-insensitive;
    people type it by hand). **Required, not optional:** the cross-device case (buy on
    phone, app on Mac → `throughline://` on the phone does nothing) means the success page +
    receipt email must show *both* an "Activate Throughline" button and the code.

### 3.4 Client (Throughline app) — grounded in current code
- New provider value `company` alongside local/openai/anthropic/codex.
- Activation: Settings → "Turn on Throughline AI ($20)" → opens Stripe Checkout in the
  system browser → app receives the **activation token** (deep link or pasted code) →
  `POST /v1/activate` → stores the returned **durable license** in the **Keychain** (like
  `cmd_set_ai_key`) → sets provider=company, model=`claude-sonnet-4-6` (locked; the B2
  picker is hidden in company mode).
- **Tauri deep-link plumbing (skip at your peril):** `tauri-plugin-deep-link` **and**
  `tauri-plugin-single-instance` *together* — without single-instance the URL spawns a 2nd
  app instance instead of focusing the running one. Register `CFBundleURLTypes` in
  `Info.plist`. Handle **both** cold-start (app launches *from* the URL) and warm-start
  (already running). The scheme only registers reliably from a **signed + notarized `.app`
  in `/Applications`** — test activation against a real release build, NOT `tauri dev`.
- `run_provider_call` gains a `Company` arm: base_url = proxy, auth = the license token.
  The existing C2 consent gate and B6 usage capture work unchanged (the proxy streams the
  same SSE incl. usage).
- **Cap-exhausted handling** — a new `CapExhausted` error (mirrors `NeedsCloudConsent`):
  the app shows a calm sheet — "You've used your Throughline AI credits. Keep going with
  your own API key, or switch to a local model — your plan and notes are untouched." →
  routes to the existing BYO-key / local setup.

---

## 4. The cap (the heart of the economics)

- **Meter internally on cost (micro-dollars); display externally as "questions."** Call-count
  is too crude (per-call cost spans ~$0.005–$0.031, a 3–6× spread). A raw token budget is
  better but still misses model choice (if anything ever routes to Haiku) and Anthropic price
  changes. **Cost in `cost_usd_micros` is the truest internal ceiling** — and we already debit
  *real* cost from Anthropic's `usage` block at stream end, zero estimation at debit time.
  - **Display** is the only place we estimate: "**~N questions left**" = remaining budget ÷
    that user's trailing-average cost-per-call, with a tilde to signal approximation. Or go
    coarser — a **fuel gauge** ("Plenty of AI left / Running low / Almost out") — which
    sidesteps "my balance jumped after a price change" entirely. Readers of Augustine think
    in questions, not tokens. *Meter in dollars, speak in questions.*
  - This meter is **load-bearing**: with no pre-launch usage data of the right kind, the
    internal cost meter is the *only* ground truth for the whole bet — getting it exact
    matters more than it otherwise would.
- **The cap is a server-side number** (proxy config / Durable Object), **never compiled into
  the client.** That single fact is what makes "what number?" un-scary — move it anytime, no
  app update. The internal cost ceiling lives in the **$2.40 (median) – $16.50 (never-cross)**
  band, with enormous headroom over the median reader.
- **Soft before hard.** First cohort: the cap is *soft* — you get **paged**, nobody gets cut
  off — so you observe the real free-at-point-of-use regime before committing a hard number.
- **Enforced server-side only.** The client *displays* remaining (read-only `GET /v1/credits`)
  but never decides eligibility. The Durable Object is authoritative.
- **Graceful fallback.** On exhaustion the app never dead-ends: BYO-key or local, one tap.

### 4.1 Launch (no prior data — and that's fine)
BYO data would be the **wrong** data: BYO users self-regulate against a price signal that
vanishes the moment Throughline pays, so they systematically under-predict free-at-point-of-use.
Company-first forfeits nothing real. The de-risker isn't more data — it's the server-tunable
soft cap above. Two ways to open the door, same mechanics:

- **Bounded cohort (recommended).** First **100–300 real buyers at $20**, cap set internally
  generous (near the ceiling, or temporarily uncapped) and **soft** (paged, never cut). Real
  money, the exact regime we're pricing; blast radius bounded (300 × even an aggressive ~$8 ≈
  $2.4k worst case over a 2–4 week window, realistically far less). Then set the public **hard
  cap at the 95th–99th percentile** of *that* observed distribution.
- **Wide launch with guardrails.** No cohort gate: launch wide but soft-enforce for the first
  cohort with aggressive per-install anomaly alerting (any install over a daily call threshold
  pages you). Same instrument, wider door, more exposure.

> **Dead trigger:** the report's "if <40% of buyers configure AI, build company-paid" gate
> was a BYO-first decision and is **moot** — we're company-first.

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

> **Two codebases.** Phases 1–3 + 5 live in a **new Cloudflare Worker project** (TypeScript,
> `wrangler`, D1, Durable Objects, AI Gateway) — *not* the Tauri app. Phase 4 is the client
> change in this repo. They meet only at the HTTP contract (`/v1/tutor`, `/v1/activate`,
> `/v1/credits`), so they can be built and tested independently against a stub token.

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

## 9. Decisions (resolved 2026-06)
1. **Posture** — company AI front door, BYO/local floor (not removed). ✅
2. **Token delivery** — deep link `throughline://activate?token=<single-use activation>` +
   **mandatory** Crockford-base32 typed code; app exchanges at `/v1/activate` for the durable
   HMAC license. Durable secret never in a URL. ✅
3. **Counter** — Durable Object per license (strongly consistent = true ceiling), not KV. ✅
4. **Cap units** — meter on `cost_usd_micros`; display "~N questions" or a fuel gauge. ✅
5. **Cap value** — server-side, soft-before-hard; bounded cohort (100–300) then hard cap at
   p95–p99 of observed. No pre-launch BYO data needed. ✅
6. **Hosting** — Cloudflare Worker + AI Gateway, `ai.throughline.app` (never `workers.dev`). ✅

**Remaining operational items (not blockers to start building):**
- Pick the display flavour — "~N questions left" vs the coarser fuel gauge (recommend
  shipping the fuel gauge first; it's robust to price changes).
- Cohort gate vs wide-launch-with-alerts — and the cohort window.
- The specific Cloudflare account + DNS record for `ai.throughline.app`.

---

## 10. What's already in place (reused, not rebuilt)
- **B6 usage parsing** (`accumulate_anthropic_usage`, the usage block fields) — the same
  parse the proxy needs server-side.
- **B4 usage panel + `ai_request_usage`** — the client-side spend view; "credits remaining"
  slots into it.
- **C2 consent gate** (`NeedsCloudConsent`) — the pattern the `CapExhausted` fallback copies.
- **B1/B2 model handling** — Sonnet default + the picker that company mode hides.
- The AI provider dispatch (`run_provider_call`) — a `Company` arm is the only new path.

# CORE-1169 gate: reproducible, auditable, honestly re-verified

This closes the blocker from the Fable diff review: the combined-gate "GREEN" was not
reproducible from committed state and rested on unauditable artifacts. It now reproduces
deterministically from committed fixtures, its judge overrides are auditable, and the
recalibration was redone with the shipping rubric and recorded honestly.

**No prompt or product-logic change.** Only `eval/plain-language/`, `.github/workflows/ci.yml`,
and two comment corrections in `src-tauri/src/ai_stub.rs` were touched.

## The honest result (regenerated with the SHIPPING judge rubric)

The 960-cell combined gate is **GREEN**, and it is a real green, not a forced one:

| Metric | Value | Bar | Pass |
|--------|-------|-----|------|
| harder rate | 21/960 = 2.2% | ≤ 5% | yes (margin) |
| jargon rate | 9/960 = 0.9% | ≤ 5% | yes |
| median delta | -0.661 | ≤ -0.5 | yes |
| worst category | victorian 8/192 = 4.2% | ≤ 5% | yes |

The green depends on **65 judge overrides** (borderline lexical false positives the judge read
as plain) plus 14 judge-added catches. The **honesty audit passes**: every one of the 65
overrides is borderline (`0 < delta < 0.5`) with a confident-plain judge (`score >= 4`) — the
judge never silenced a genuinely-harder item (`overrides_audit.py` exits non-zero if it ever
did). See `reports/core_1169_overrides_audit.md` (every override + the judge's reason) and
`reports/core_1169_review_worksheet.md` (a sample for a human 8th-grade spot-check).

## Shipping-rubric calibration (replaces the unreproducible 1.000/0.886 claim)

Regenerated on the 20 human labels with the fixed (Fix #2) judge rubric, reproduced offline
from the committed content-hashed cache (`calibration/worksheet_verdicts_shipping.json`):

- **combined harder kappa = 0.857** (was 0.688 old-rubric), 0 false positives on the 20 labels
- **combined jargon kappa = 0.783** (was 0.762 old-rubric), 0 false positives

Both clear the 0.61 bar. The Fix #2 rubric genuinely improves agreement — just not to the
1.000/0.886 the last commit claimed (that number reproduced nowhere). `thresholds.json` now
records 0.857/0.783 with the committed cache as its source, and a test asserts it.

## How it reproduces (no model, no lexicon)

```bash
python verify_gate.py        # recompute the gate from committed fixtures; exit 0 = reproduced
python -m pytest tests/ -q   # includes the fixture-reproduction + content-hash-key tests
```

- The lexical scores are committed IN `fixtures/core_1169_run.json` (per-item `lex_*`), so
  verification needs neither a model nor the license-bound AoA lexicon.
- Judge verdicts are committed in `fixtures/core_1169_judge_verdicts.json`, keyed
  `model|rubric_fp|id|text_sha` (content + rubric bound), so a stale or wrong-text verdict can
  never be silently reused.
- The `plain-language-gate` CI job runs both, so the gate is a protected check.

## Regenerating the fixtures (the one authorized model step)

```bash
python regen_run_verdicts.py --run reports/run.json \
    --out fixtures/core_1169_judge_verdicts.json --judge local:gpt-oss:20b
python verify_gate.py --write-expected
python overrides_audit.py
```

## Known limitation (recorded honestly)

2 of the 960 deep-tier items (`iron-09|vocabulary|deep|anthropic`,
`vict-06|explain|deep|anthropic`) send gpt-oss:20b into a repetition loop and return no
parseable verdict, so they are recorded as `score = 0` ("unparseable judge output"). A
score-0 verdict is treated **conservatively** — it flags, never clears/overrides — so it
cannot inflate the green (it is counted in, not out of, the harder tally). The green holds
with them counted as flags. If a cleaner verdict for these two is wanted, judge them with the
alternate cross-family model (gemma3:12b); it does not change the pass.

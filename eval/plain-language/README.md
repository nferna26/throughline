# Plain-language eval harness (CORE-1169 part 1, the referee)

A standalone, offline Python harness that measures whether the Throughline margin
tutor's **explanation is plainer than the passage it explains**, and gates prompt
changes on it. The headline pass/fail is a **deterministic lexical difficulty delta**
(explanation minus source); an optional cross-family LLM judge is a secondary flag.

This is **part 1 (the referee)**. It does **not** change the app prompt; that is part
2, which is proven against this harness.

## Quick start

```bash
cd eval/plain-language
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python download_lexicons.py     # OPTIONAL: adds Kuperman AoA; harness runs fine without it

# Offline BASELINE over recorded current-prompt outputs (asserts the gate is RED and
# flags the known "communistic -> mock-academic solemnity" failure):
python run_eval.py --baseline

# Full deterministic test suite (no network, no models):
python -m pytest tests/ -q

# Calibration: does the metric agree with a human? (Cohen's kappa + Spearman)
python calibrate.py --ratings calibration/handrated.csv
```

Live runs (cost money / need a local model), once a backend is configured:

```bash
cp env.example .env                 # or create .env by hand; never commit it
# ANTHROPIC_API_KEY=...             # cloud tier
# LOCAL_AI_BASE_URL=http://localhost:11434/v1
python run_eval.py --models 'anthropic:claude-sonnet-4-6' 'local:my-8b' \
                   --tiers brief deep --lenses explain historical vocabulary socratic \
                   --judge gemini --out reports/run.json
```

When `LOCAL_AI_BASE_URL` points at Ollama's default OpenAI-compatible endpoint
(`http://localhost:11434/v1`), the harness uses Ollama's native chat API under the
hood with thinking disabled. This keeps thinking models such as `qwen3.5:latest`
from spending the entire eval budget in a hidden reasoning field.

For long live runs, set `PLAINEVAL_PROGRESS=1` to print the current
passage/tier/model/lens to stderr while the final report is still written at the end.

## Calibrate before you trust the verdict (CORE-1169 part 1b)

A live run over real Sonnet + local output came back RED (753/960 harder-than-source,
median +0.487), but the scorer had visible bugs that inflated the numbers and it had
never been checked against a human. **Fix the referee, then validate it against human
judgment, before any prompt is tuned against it.** The flow:

```bash
# 1. capture a live run (now persists per-item source+explanation, so it is re-scorable)
python run_eval.py --models 'anthropic:claude-sonnet-4-6' 'local:qwen3.5:latest' \
                   --tiers brief deep --lenses explain historical vocabulary socratic \
                   --out reports/run.json

# 2. re-score that SAME captured text with the fixed scorer, and isolate the scorer's
#    effect by diffing against the legacy scorer at the part-1 git ref (same text, two
#    scorers -> the delta is purely the bug fixes, the model output is held fixed):
python rescore.py --run reports/run.json --legacy-ref claude/plain-language-eval

# 3. sample a ~20-item labelling worksheet from the live outputs (stratified across the
#    5 categories x both tiers x both models, spanning the delta range; the gate's own
#    verdict is NOT shown, so the labels are unanchored):
python calibrate.py --make-worksheet --from reports/run.json --out calibration/worksheet.csv

# 4. >>> Nick labels each row: human_harder (0/1) and human_has_undefined_hard_word (0/1) <<<

# 5. compute agreement: Cohen's kappa on BOTH axes, plus a disagreement breakdown that
#    separates FALSE POSITIVES (gate flags genuinely-plain text = the short-text lexical
#    bias) from true catches:
python calibrate.py --ratings calibration/worksheet.csv
```

**Decision rule.** If kappa is high (>= 0.61 substantial) and false positives are few,
the re-scored verdict can referee prompt edits (part 2b proceeds). If kappa is low or
false positives are high, the threshold/metric needs more tuning first.

**Honesty note on the first live run.** It did *not* persist per-item explanations
(only a progress log + the gate summary survived in `live-run.log`), so its exact 960
outputs cannot be re-scored. Per-item persistence (the `items` array in `--out`) was
added here so this never recurs; `rescore.py` re-scores any captured run with no model
calls. The scorer bugs that inflated that run (now fixed + unit-tested):

1. **Unicode/accent tokenization** — the ASCII tokenizer mangled accented words
   ("Brontë" -> `bront`, "Übermensch" -> `bermensch`), and the proper-noun check also
   failed on the accented capital, so names leaked into the jargon set. Fixed by
   folding accents (NFKD) before tokenizing and in the proper-noun check.
2. **Archaic/variant named-term exclusion** — a word quoted from an archaic source
   ("talke"/"thinke"/"olde") was flagged though present in the source. Fixed with an
   `archaic_key` fold (trailing -e, i/y, doubled consonants) used to match the
   exclusion, applied to both the jargon gate and the difficulty delta.
3. **Jargon threshold over-flagging** — mid-frequency words a fluent adult knows
   (murmur, predictability, passivity) tripped the `Zipf < 3.0` cutoff. Lowered to
   **2.6** (documented in `thresholds.json`, which `jargon.py` now reads as the single
   source of truth); the canonical academic-register failures (solemnity, litotes,
   deontological) still flag. The ~2.3-2.9 band is register-dependent and is exactly
   what the calibration step measures. AoA is unavailable in this environment, so the
   rarity cutoff is the sole active binary signal.

## Register-sensitive combined gate (CORE-1169 part 1c)

Human calibration (Nick, 20 labels, adult ~8th-grade-clarity standard) put the
LEXICAL-ONLY gate at kappa **0.39 (harder?) / 0.52 (jargon?)** -- "fair/moderate,"
below the 0.61 needed to referee alone. Human and gate agree *directionally* (16/20
items human-harder), so the signal is real; the gate's misses are **register** --
academic/abstract tone that word-rarity (Zipf) cannot see (mid-frequency words that
still read academic: "dispassionate", "posits", "reframe"). Two fixes:

1. **AoA activated** (a cheap lexical boost): `download_lexicons.py` now fetches the
   Kuperman age-of-acquisition norms (30,121 words; license-bound, so gitignored, not
   committed). A word learned after ~age 14 reads as academic register; `hard_aoa` is
   set to 14.0 (jargon-axis kappa 0.375 -> 0.519, zero new false positives). AoA is
   kept OUT of the difficulty/delta blend (it inflated archaic-source difficulty and
   *lowered* the harder-axis kappa) -- the delta stays the objective lexical spine.
2. **The judge** (`plaineval/judge.py`): a G-Eval pointwise plainness rubric
   (q1 no-dictionary, q2 simpler-words, q3 free-of-academic-register, q4 needs-its-own-
   explanation; score 1-5, temperature 0, JSON), run by an **independent, cross-family**
   model -- never Sonnet (the tutor) nor qwen3.5 (the local tutor), to avoid
   self-preference. Offline default `gpt-oss:20b` via Ollama; configurable with
   `--judge local:<model>` or `JUDGE_MODEL` / `JUDGE_BASE_URL`. Verdicts are cached
   (`reports/judge_cache.json`) so calibration re-runs are offline and free.

**The combined referee** (`plaineval/referee.py`, pure + unit-tested):

```
harder = lexical delta > 0          OR  judge plainness score <= bar (default 3)
jargon = lexical undefined-hard > 0 OR  judge says academic register present (q3 False)
```

The lexical delta stays the objective spine; the judge only ever ADDS the register
catch (OR), never silences a lexical flag.

**Calibration result (gpt-oss:20b, bar 3, Nick's 20 labels):**

| gate | harder kappa | jargon kappa |
|---|---|---|
| lexical-only | 0.390 (fair) · raw 0.75 · PABAK 0.50 | 0.519 (moderate) · raw 0.75 · PABAK 0.50 |
| **combined** | **0.688 (substantial)** · raw 0.90 · PABAK 0.80 | **0.875 (almost perfect)** · raw 0.95 · PABAK 0.90 |

The judge newly catches 3 harder + 6 jargon register cases the lexical gate missed
(harder-misses 4->1, jargon-misses 5->0), at 1 false positive. **Both axes clear the
0.61 bar -> the combined gate can referee part 2b.** Reproduce offline:

```bash
python calibrate.py --ratings calibration/worksheet.csv --judge local:gpt-oss:20b --judge-bar 3
```

(PABAK = 2*raw_agreement - 1, reported alongside kappa because the base rate is skewed
-- most items are "harder," which depresses kappa even at high agreement.)

## Gate fixes after the part-2b live run (CORE-1169 part 2b)

The first plain-prompt live run exposed that the combined gate, calibrated on *part-1*
(jargon-heavy) output, false-positives on *plain* output: 74/960 lexical-harder items of
which the judge itself rated 71 (96%) PLAIN, and a jargon count dominated by archaic
spellings of common words. Nick authorized three gate fixes, with the rule that **GREEN
counts only if the changed gate still agrees with the 20 labels at kappa >= 0.61**:

1. **Fix #2 (clean bug):** `jargon.is_hard` now folds accents + a single trailing archaic
   `-e` before the rarity check (`_rarity_zipf`), so a plain word the model spelled
   archaically (`thinke`=think 6.08, `growe`=grow, `mixe`=mix) is read at the modern
   word's frequency. Cut full-run jargon 117 -> 39 with **no change to the calibration
   kappa** (0.688 / 0.875). Only the trailing -e, not the full `archaic_key` (whose i/y
   fold makes non-words like `play`->`plai`).
2. **Fix #1 (referee, REVERSES part-1c "judge only adds" on BOTH axes):** the judge may now
   OVERRIDE a lexical false positive. On HARDER, only a *borderline* flag (`0 < delta < 0.5`)
   when confidently plain (`score >= 4`) -- the 0.5 delta gate is the calibration boundary
   that keeps **harder kappa at 0.688** (a blanket override drops it to 0.571). On JARGON,
   the judge clears a lexical flag when it sees no academic register (`q3 True`) -- it
   separates plain compounds (`countable`, `guessable`) from real jargon (`solemnity`)
   better than rarity can, at **jargon kappa 0.762** (down from 0.875, still >= 0.61).
3. **Fix #3 (rate thresholds, `gate_rates`):** absolute counts (`max_harder=0`, etc.) were
   locked for the 20-item baseline and are infeasible on 960 cells. `evaluate_gate` now
   gates on RATES for a large run, set to the combined gate's **calibrated 5% false-
   positive rate** on the 20 labels (1 harder FP, 1 jargon FP) -- from the calibration,
   not to make any run pass. median_delta_max (-0.5) is unchanged.

`combined_gate.py` applies the fixed gate to a persisted run (judge cached, offline):

```bash
python combined_gate.py reports/run.json --judge local:gpt-oss:20b
```

## What it measures

For each passage x {brief, deep} x {model} it gets the tutor's explanation, then:

- **D(text)** is a lexical-difficulty-first blend (~85% lexical, ~15% formulas):
  - word rarity (wordfreq Zipf), age-of-acquisition (Kuperman, optional), Dale-Chall
    unfamiliar-word proportion;
  - classic formulas (Flesch-Kincaid / SMOG / Dale-Chall) at low weight, advisory on
    short text (one quoted polysyllable can swing them, so they never dominate);
  - each signal z-normalized against a fixed baked reference corpus, then weighted-summed.
- **delta = D(explanation) - D(source)**. PASS when `delta <= 0`.
- **Named-term exclusion** (the critical move): an explanation word is exempt from the
  explanation's score when it (a) appears in the source, or (b) is glossed in-line in
  the same sentence. So the explanation is never penalized for naming/defining the hard
  term it must explain (e.g. "communistic", "panopticon", "bourgeoisie").
- D is also reported **without the single rarest token** (robustness view).
- **Jargon detector**: content-word lemmas the explanation introduces that are absent
  from the source, genuinely hard (low Zipf or high AoA), and not glossed in-line, minus
  proper nouns. Any undefined introduced-hard-word is a violation.

## The gate (locked in `thresholds.json`)

A prompt iteration **PASSES** (GREEN, exit 0) only if, across all items:

1. **0 explanations harder than their source** (count of `delta > 0` == 0). *Hard gate.*
2. **median delta <= -0.5** (explanations meaningfully easier, not barely).
3. **0 undefined introduced-hard-words** (jargon detector).
4. **per category**, no difficulty type with more than 1 harder-than-source item.

The runner exits **non-zero (RED)** on any hard-gate failure, so a prompt edit that
helps philosophy but breaks irony cannot merge silently. The judge is secondary: it is
reported and flags items for human review, but never auto-fails the headline on its own.

The lexical gate is **deterministic and reproducible**: wordfreq ships a frozen data
snapshot and the reference distribution is baked in source, so the same input gives the
same score with no network, keys, or model.

## Dataset

`dataset/passages.json`: 60 public-domain (Project Gutenberg) passages, 12 per
difficulty type (archaic diction, dense philosophy, irony, long Victorian sentences,
technical/scientific), each tagged `{type, length_words(implied), source_title, author,
has_archaic_quote, has_irony}`. Several `named_hard_term` cases (communistic, panopticon,
bourgeoisie, refrangibility, ...) exercise the exclusion rule.

## Baseline (recorded)

`fixtures/baseline_recorded.json` holds explanations from the **current, unchanged**
prompt. The current prompt asks for "plain flowing prose" but has no *relative*
difficulty constraint, so it fails on the hard-vocabulary / irony / dense-philosophy
class. `python run_eval.py --baseline` confirms the gate flags this: the
**"communistic -> mock-academic solemnity" case scores delta > 0** (RED), while the
named-term cases (panopticon, bourgeoisie) correctly score `delta <= 0` (the exclusion
works). `reports/baseline.json` is the machine-readable record for diffing part 2.

## The judge (independent, cross-family; now part of the combined gate)

`plaineval/judge.py`: a G-Eval-style 1-5 plainness rubric, scored pointwise at
temperature 0, by a **cross-family** model (never Claude/Sonnet, to avoid self-preference
bias): Gemini/GPT in the cloud, or a local open model (`gpt-oss:20b` default, configurable)
for offline runs. As of part 1c it is no longer flag-only -- it is OR-combined with the
lexical gate (see "Register-sensitive combined gate" above) because the lexical signal
alone cannot see academic register. The lexical delta remains the objective spine.
`calibrate.py` validates judge + lexical agreement vs a labelled set (Cohen's kappa,
Spearman; target kappa >= 0.61). `calibration/handrated.csv` is a small **seed only**
(~20 rows on the recorded baseline fixtures, harder-axis only, author-assigned) and is
**not** a substitute for the part-1b calibration: that uses a worksheet sampled from
real live outputs, labelled by a human on **both** the harder and jargon axes (see
"Calibrate before you trust the verdict" above). Treat any kappa from the seed as
provisional until the live-output worksheet is labelled.

## Lexicons (offline)

- **wordfreq** (rarity) and **Dale-Chall** (familiarity, via textstat) are bundled: the
  harness + the gate run with **zero downloads**.
- **Kuperman AoA** is optional: `download_lexicons.py` tries a few mirrors;
  `vendor/aoa_kuperman.csv` (columns `Word`, `Rating.Mean`) is used if present. When
  absent, the blend re-normalizes over rarity + Dale-Chall (still ~85/15 lexical/formula)
  and logs AoA coverage as 0. Low-coverage passages (archaic/proper-heavy) are flagged so
  their D is read with caution.

## Drift guard

`plaineval/tutor_prompt.py` is a faithful Python replica of
`src-tauri/src/ai_stub.rs::build_prompt_with_depth`. `assert_matches_rust()` (a test)
reads the Rust source and fails loudly if the load-bearing directive strings change, so
the replica cannot silently diverge from the real prompt. When part 2 edits the Rust
prompt, bump `CURRENT_PROMPT_VERSION` and update the replica in lock-step.

## Layout

```
plaineval/        lexicons, difficulty (D), jargon, metrics (delta), gate, report,
                  backends (recorded/anthropic/local), judge, tutor_prompt (replica)
dataset/          passages.json (60 tagged PG passages)
fixtures/         baseline_recorded.json (current-prompt outputs)
calibration/      handrated.csv (seed); worksheet.csv (live-output labelling sheet)
reports/          machine-readable run outputs (run.json now carries per-item text)
thresholds.json   the LOCKED gate definition (jargon cutoffs read by jargon.py)
run_eval.py       the runner + red/green headline + non-zero exit (+ per-item persistence)
rescore.py        re-score a captured run; --legacy-ref diffs the pre-fix scorer
calibrate.py      kappa (harder + jargon) / PABAK; --judge runs the COMBINED gate
plaineval/referee.py   the combined referee (lexical OR judge); pure + unit-tested
plaineval/judge.py     G-Eval plainness judge (cross-family) + offline score cache
download_lexicons.py   optional AoA fetch
tests/            deterministic pytest (no network)
```

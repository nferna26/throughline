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
export ANTHROPIC_API_KEY=...        # cloud tier
python run_eval.py --models 'anthropic:claude-sonnet-4-6' 'local:my-8b' \
                   --tiers brief deep --lenses explain historical vocabulary socratic \
                   --judge gemini --out reports/run.json
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

## The judge (optional, secondary, independent)

`plaineval/judge.py`: a G-Eval-style 1-5 plainness rubric, scored pointwise at
temperature 0, by a **cross-family** model (never Claude/Sonnet, to avoid self-preference
bias): Gemini/GPT in the cloud, or Llama-3.1-8B locally for offline runs. It is flag-only.
`calibrate.py` validates judge + lexical agreement vs a hand-rated set (Cohen's kappa,
Spearman; target kappa >= 0.61). The seed `calibration/handrated.csv` already shows the
**lexical gate agrees with human "harder?" labels at kappa ~= 0.86**; expand it to ~50
mixed items for a stable judge calibration.

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
calibration/      handrated.csv (seed; expand to ~50)
reports/          machine-readable run outputs
thresholds.json   the LOCKED gate definition
run_eval.py       the runner + red/green headline + non-zero exit
calibrate.py      kappa / Spearman calibration
download_lexicons.py   optional AoA fetch
tests/            deterministic pytest (no network)
```

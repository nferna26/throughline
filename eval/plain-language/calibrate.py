#!/usr/bin/env python3
"""Calibration (handoff 2.4): does the metric agree with a human?

Validates two things against ~50 hand-rated explanations:
  1. The LEXICAL gate (the metric that actually gates): Cohen's kappa between the
     human "harder than source?" label and the lexical (delta > 0) label. This is the
     most important number, because the lexical delta is the headline gate.
  2. The optional JUDGE: Cohen's kappa on the binary label + Spearman on the 1-5
     score vs human, to decide whether the judge is trustworthy as a secondary flag
     (target kappa >= 0.61 substantial, Spearman >= 0.5 per G-Eval).

Usage:
  python calibrate.py --make-template            # emit a blank CSV to fill in
  python calibrate.py --ratings calibration/handrated.csv [--judge gemini]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from plaineval import judge as JU  # noqa: E402
from plaineval import metrics  # noqa: E402
from plaineval import referee  # noqa: E402

CAL_DIR = os.path.join(HERE, "calibration")
DEFAULT_RATINGS = os.path.join(CAL_DIR, "handrated.csv")
FIELDS = ["id", "source", "explanation", "human_score", "human_harder"]
# The part-1b worksheet: sampled from real live outputs, labelled on two binary axes.
# The gate's own verdict is deliberately NOT shown, so the labels are unanchored; the
# calibration step recomputes the gate from source+explanation.
WORKSHEET_FIELDS = [
    "id",
    "category",
    "tier",
    "model",
    "lens",
    "source",
    "explanation",
    "human_harder",
    "human_has_undefined_hard_word",
]
DEFAULT_WORKSHEET = os.path.join(CAL_DIR, "worksheet.csv")


def make_template(out: str, n: int) -> None:
    """Emit a CSV seeded from the dataset + baseline fixtures for the dev to rate."""
    os.makedirs(os.path.dirname(out), exist_ok=True)
    passages = {
        p["id"]: p
        for p in json.load(open(os.path.join(HERE, "dataset", "passages.json")))["passages"]
    }
    fx = json.load(open(os.path.join(HERE, "fixtures", "baseline_recorded.json")))["explanations"]
    rows = []
    for key, expl in fx.items():
        pid, lens, tier, model = key.split("|")
        p = passages.get(pid)
        if not p:
            continue
        rows.append({"id": f"{pid}|{lens}|{tier}|{model}", "source": p["text"], "explanation": expl, "human_score": "", "human_harder": ""})
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows[:n])
    print(f"wrote {out} with {min(n, len(rows))} rows; fill human_score (1-5) and human_harder (0/1), aim for ~50 mixed items.")


def make_worksheet(run_path: str, out: str, n: int) -> None:
    """Sample ~n labelling items from a persisted live run (run.json's `items`).

    Stratified to be a fair calibration set: spread across the 5 categories x both
    tiers x both models, and across the gate's delta range (deliberately mixing items
    the gate calls harder with items it does not), so kappa is computed on a balanced
    sample rather than one dominated by a single class. The gate verdict is not written
    into the worksheet (no anchoring); calibrate recomputes it at scoring time.
    """
    from plaineval import metrics  # local import: scoring is only needed here

    with open(run_path, encoding="utf-8") as fh:
        items = json.load(fh).get("items") or []
    if not items:
        raise SystemExit(
            f"{run_path} has no 'items' (source+explanation). Capture a run with "
            "`run_eval.py --out` (now persists per-item text) first."
        )
    # Attach the gate delta + harder flag for stratified, delta-spanning selection.
    scored = []
    for it in items:
        m = metrics.evaluate(it["source"], it["explanation"])
        scored.append({**it, "_delta": m.delta, "_harder": m.harder_than_source})

    # Deterministic stratification: bucket by (category, tier, model) so the sample
    # covers all 5 categories x both tiers x both models, then walk the buckets
    # round-robin taking the delta-extremes first so the sample also spans the range
    # (mixing items the gate calls harder with items it does not).
    buckets: dict[tuple, list[dict]] = {}
    for s in scored:
        buckets.setdefault((s["category"], s["tier"], s["model"]), []).append(s)
    for b in buckets.values():
        b.sort(key=lambda s: s["_delta"])  # ascending; ends are the extremes

    picked: list[dict] = []
    keys = sorted(buckets.keys())
    # Two pointers per bucket (low-delta end, high-delta end). Alternate which end each
    # bucket contributes (by bucket index, flipped each round) so the picks span the
    # delta range -- deliberately mixing high-delta items the gate calls harder with
    # low-delta items it clears, rather than taking one extreme from every bucket.
    cursors = {k: [0, len(buckets[k]) - 1] for k in keys}
    round_i = 0
    while len(picked) < n and any(cursors[k][0] <= cursors[k][1] for k in keys):
        for idx, k in enumerate(keys):
            if len(picked) >= n:
                break
            lo, hi = cursors[k]
            if lo > hi:
                continue
            if (idx + round_i) % 2 == 0:
                picked.append(buckets[k][lo])
                cursors[k][0] += 1
            else:
                picked.append(buckets[k][hi])
                cursors[k][1] -= 1
        round_i += 1

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=WORKSHEET_FIELDS)
        w.writeheader()
        for s in picked[:n]:
            w.writerow(
                {
                    "id": s["key"],
                    "category": s["category"],
                    "tier": s["tier"],
                    "model": s["model"],
                    "lens": s["lens"],
                    "source": s["source"],
                    "explanation": s["explanation"],
                    "human_harder": "",
                    "human_has_undefined_hard_word": "",
                }
            )
    n_harder = sum(1 for s in picked[:n] if s["_harder"])
    cats = sorted({s["category"] for s in picked[:n]})
    print(
        f"wrote {out} with {len(picked[:n])} items "
        f"({n_harder} the gate calls harder, {len(picked[:n]) - n_harder} not; "
        f"categories: {', '.join(cats)}).\n"
        "Label each row: human_harder (1 if the explanation reads HARDER than the "
        "source, else 0) and human_has_undefined_hard_word (1 if it introduces a hard "
        "word it does not define, else 0). Then run: python calibrate.py --ratings "
        f"{out}"
    )


def cohens_kappa(a: list[int], b: list[int]) -> float:
    from sklearn.metrics import cohen_kappa_score

    return float(cohen_kappa_score(a, b))


def spearman(a: list[float], b: list[float]) -> float:
    from scipy.stats import spearmanr

    r = spearmanr(a, b).statistic
    return float(r) if r == r else 0.0  # nan-guard


def landis_koch(k: float) -> str:
    for lo, label in [(0.81, "almost perfect"), (0.61, "substantial"), (0.41, "moderate"), (0.21, "fair"), (-1, "slight/poor")]:
        if k >= lo:
            return label
    return "poor"


def _disagreements(rows: list[dict], human: list[int], gate: list[int], axis: str) -> None:
    """List the rows where the gate and human disagree, split into false positives
    (gate flags, human does not -- the short-text lexical bias the research warned of)
    and false negatives / missed catches (gate clears, human flags)."""
    fp = [(r, h, g) for r, h, g in zip(rows, human, gate) if g == 1 and h == 0]
    fn = [(r, h, g) for r, h, g in zip(rows, human, gate) if g == 0 and h == 1]
    print(f"  FALSE POSITIVES ({axis}): gate flags, human says no -- {len(fp)} "
          "(lexical over-flagging / short-text bias)")
    for r, _h, _g in fp:
        print(f"    [{r.get('id', '?')}] {(r['explanation'] or '')[:90]!r}")
    print(f"  MISSED ({axis}): human flags, gate clears -- {len(fn)}")
    for r, _h, _g in fn:
        print(f"    [{r.get('id', '?')}] {(r['explanation'] or '')[:90]!r}")


def _agreement(human: list[int], gate: list[int]) -> tuple[float, float, float]:
    """kappa, raw agreement, and PABAK (prevalence-adjusted bias-adjusted kappa).

    PABAK = 2*p_observed - 1. Reported alongside kappa because the base rate here is
    skewed (most items are 'harder'), which depresses kappa even at high raw agreement
    -- the kappa paradox. PABAK shows agreement net of that prevalence effect.
    """
    k = cohens_kappa(human, gate)
    raw = sum(1 for a, b in zip(human, gate) if a == b) / len(human)
    return k, raw, 2 * raw - 1


def _report_axis(title: str, rows: list[dict], human: list[int], gate: list[int], axis: str) -> float:
    k, raw, pabak = _agreement(human, gate)
    print(f"\n{title}:  kappa={k:.3f} ({landis_koch(k)})  raw-agreement={raw:.2f}  PABAK={pabak:.3f}")
    _disagreements(rows, human, gate, axis)
    return k


def run(ratings: str, judge_spec: str, judge_bar: int = referee.DEFAULT_JUDGE_BAR,
        cache_path: str | None = None) -> int:
    if not os.path.exists(ratings):
        print(f"no ratings file at {ratings}; run --make-worksheet --from reports/run.json first, then hand-label.")
        return 2
    rows = [r for r in csv.DictReader(open(ratings, encoding="utf-8")) if (r.get("human_harder") or "").strip() != ""]
    if len(rows) < 5:
        print(f"only {len(rows)} labelled rows; label ~20+ for a stable kappa.")
        return 2
    have_jargon = any((r.get("human_has_undefined_hard_word") or "").strip() != "" for r in rows)

    lex = [metrics.evaluate(r["source"], r["explanation"]) for r in rows]
    human_harder = [int(r["human_harder"]) for r in rows]
    lex_harder = [1 if m.harder_than_source else 0 for m in lex]
    jrows = [r for r in rows if (r.get("human_has_undefined_hard_word") or "").strip() != ""]
    human_jargon = [int(r["human_has_undefined_hard_word"]) for r in jrows]
    lex_jargon = [1 if metrics.evaluate(r["source"], r["explanation"]).jargon else 0 for r in jrows]

    print("=" * 70)
    print(f"CALIBRATION  ·  {len(rows)} labelled items  ·  ratings: {os.path.basename(ratings)}")
    print("=" * 70)
    print("\n### LEXICAL-ONLY gate (the objective spine) ###")
    _report_axis("harder?", rows, human_harder, lex_harder, "harder")
    if have_jargon:
        _report_axis("undefined hard word (jargon)?", jrows, human_jargon, lex_jargon, "jargon")

    combined_kappa = {"harder": None, "jargon": None}
    if judge_spec and judge_spec.lower() not in ("none", "off", ""):
        judge = JU.make_judge(judge_spec)
        cache_path = cache_path or os.path.join(HERE, "reports", "judge_cache.json")
        model_label = judge_spec.split(":", 1)[1] if ":" in judge_spec else getattr(judge, "name", judge_spec)
        items = [{"id": r["id"], "source": r["source"], "explanation": r["explanation"]} for r in rows]
        scores = JU.score_items_cached(judge, items, cache_path, model_label=model_label)

        comb = [
            referee.combine(
                lexical_harder=m.harder_than_source,
                lexical_jargon=len(m.jargon),
                judge_score=scores[r["id"]]["score"],
                judge_q3=scores[r["id"]]["q3"],
                judge_bar=judge_bar,
            )
            for r, m in zip(rows, lex)
        ]
        comb_by_id = {r["id"]: c for r, c in zip(rows, comb)}
        comb_harder = [1 if c.harder else 0 for c in comb]
        comb_jargon = [1 if comb_by_id[r["id"]].jargon else 0 for r in jrows]

        print(f"\n\n### COMBINED gate = lexical OR judge ({model_label}, bar<= {judge_bar}) ###")
        combined_kappa["harder"] = _report_axis("harder?", rows, human_harder, comb_harder, "harder")
        if have_jargon:
            combined_kappa["jargon"] = _report_axis("undefined hard word (jargon)?", jrows, human_jargon, comb_jargon, "jargon")

        new_h = sum(1 for c in comb if c.judge_harder and not c.lexical_harder)
        new_j = sum(1 for r in jrows if comb_by_id[r["id"]].judge_register and not comb_by_id[r["id"]].lexical_jargon)
        print(f"\nRegister catches the JUDGE newly adds (lexical gate missed): {new_h} harder, {new_j} jargon")

    print("\n" + "=" * 70)
    print("DELIVERABLE: combined-gate kappa (harder) =",
          f"{combined_kappa['harder']:.3f}" if combined_kappa["harder"] is not None else "n/a (no judge)")
    print("PASS = combined kappa >= 0.61 (substantial) with an acceptable false-positive")
    print("rate -> the gate can referee part 2b. If short, the report names which lever to")
    print("tune (lexical threshold vs judge rubric/bar) and provides an expanded worksheet.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Calibrate the plain-language gate against human labels.")
    ap.add_argument("--ratings", default=DEFAULT_WORKSHEET, help="labelled worksheet/ratings CSV")
    ap.add_argument("--judge", default="none")
    ap.add_argument("--make-template", action="store_true", help="seed a CSV from the baseline fixtures (legacy)")
    ap.add_argument("--make-worksheet", action="store_true", help="sample a labelling worksheet from a live run")
    ap.add_argument("--from", dest="run_path", default=os.path.join(HERE, "reports", "run.json"),
                    help="run.json (with per-item text) to sample the worksheet from")
    ap.add_argument("--out", default=DEFAULT_WORKSHEET, help="worksheet output path (with --make-worksheet)")
    ap.add_argument("--judge-bar", type=int, default=referee.DEFAULT_JUDGE_BAR,
                    help="judge plainness score <= bar counts as a register 'harder' catch")
    ap.add_argument("--judge-cache", default=os.path.join(HERE, "reports", "judge_cache.json"),
                    help="where cached judge verdicts live (offline-reproducible)")
    ap.add_argument("--n", type=int, default=20)
    args = ap.parse_args()
    if args.make_worksheet:
        make_worksheet(args.run_path, args.out, args.n)
        return 0
    if args.make_template:
        make_template(args.ratings, args.n)
        return 0
    return run(args.ratings, args.judge, judge_bar=args.judge_bar, cache_path=args.judge_cache)


if __name__ == "__main__":
    raise SystemExit(main())

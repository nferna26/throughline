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

CAL_DIR = os.path.join(HERE, "calibration")
DEFAULT_RATINGS = os.path.join(CAL_DIR, "handrated.csv")
FIELDS = ["id", "source", "explanation", "human_score", "human_harder"]


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


def run(ratings: str, judge_spec: str) -> int:
    if not os.path.exists(ratings):
        print(f"no ratings file at {ratings}; run --make-template first, then hand-rate ~50 rows.")
        return 2
    rows = [r for r in csv.DictReader(open(ratings, encoding="utf-8")) if (r.get("human_harder") or "").strip() != ""]
    if len(rows) < 5:
        print(f"only {len(rows)} rated rows; rate ~50 for a stable kappa (>=20 minimum).")
        return 2

    human_harder, lex_harder = [], []
    human_score, neg_delta = [], []
    judge = JU.make_judge(judge_spec)
    judge_harder, judge_score = [], []

    for r in rows:
        m = metrics.evaluate(r["source"], r["explanation"])
        hh = int(r["human_harder"])
        human_harder.append(hh)
        lex_harder.append(1 if m.harder_than_source else 0)
        if (r.get("human_score") or "").strip():
            human_score.append(float(r["human_score"]))
            neg_delta.append(-m.delta)
            if judge:
                js = judge.score(r["source"], r["explanation"]).score
                judge_score.append(js)
                judge_harder.append(1 if js <= 2 else 0)

    print("=" * 60)
    print(f"CALIBRATION  ·  {len(rows)} rated items")
    print("=" * 60)
    k_lex = cohens_kappa(human_harder, lex_harder)
    print(f"LEXICAL gate vs human 'harder?':  kappa = {k_lex:.3f} ({landis_koch(k_lex)})")
    if human_score and neg_delta:
        s_lex = spearman(human_score, neg_delta)
        print(f"LEXICAL plainness (-delta) vs human 1-5:  Spearman = {s_lex:.3f}")
    if judge and judge_harder:
        k_j = cohens_kappa(human_harder[: len(judge_harder)], judge_harder)
        s_j = spearman(human_score[: len(judge_score)], judge_score)
        print(f"JUDGE vs human 'harder?':  kappa = {k_j:.3f} ({landis_koch(k_j)})")
        print(f"JUDGE 1-5 vs human 1-5:  Spearman = {s_j:.3f}  (target >= 0.5; G-Eval ~0.51)")
        if k_j < 0.41:
            print("JUDGE kappa < 0.41: rubric ambiguous; revise + re-calibrate, or keep judge flag-only.")
    print("=" * 60)
    print("Note: the LEXICAL gate is the headline. kappa >= 0.61 (substantial) is the bar; "
          "the judge is secondary and never auto-fails the headline.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratings", default=DEFAULT_RATINGS)
    ap.add_argument("--judge", default="none")
    ap.add_argument("--make-template", action="store_true")
    ap.add_argument("--n", type=int, default=50)
    args = ap.parse_args()
    if args.make_template:
        make_template(args.ratings, args.n)
        return 0
    return run(args.ratings, args.judge)


if __name__ == "__main__":
    raise SystemExit(main())

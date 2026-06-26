#!/usr/bin/env python3
"""Apply the CALIBRATED COMBINED gate (lexical spine + register judge, with fix #1
override) to a persisted run.json, using the committed thresholds + gate logic.

CORE-1169 part 2b: this is the canonical combined-gate verdict. For each item it scores
the lexical delta + jargon, attaches the judge's verdict (cached, so re-runs are offline
and free), combines them via referee.combine (the judge may OVERRIDE a borderline lexical
false positive), and runs gate.evaluate_gate -- which gates on the calibrated RATE
thresholds (fix #3) for a large run. The judge verdicts are cached per (model, item).

  python combined_gate.py reports/run.json --judge local:gpt-oss:20b --cache reports/judge_cache_run.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plaineval import gate as G  # noqa: E402
from plaineval import judge as JU  # noqa: E402
from plaineval import metrics as M  # noqa: E402
from plaineval import referee as RF  # noqa: E402
from plaineval import report as RP  # noqa: E402  (only for tutor_prompt version)
from plaineval import tutor_prompt as tp  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--judge", default="local:gpt-oss:20b")
    ap.add_argument("--cache", default=None)
    ap.add_argument("--out", default=None, help="write the combined-gate JSON")
    args = ap.parse_args()

    data = json.load(open(args.run, encoding="utf-8"))
    items = data["items"]
    for it in items:
        it.setdefault("id", it.get("key"))

    cache = args.cache or os.path.join(HERE, "reports", "judge_cache_run.json")
    model_label = args.judge.split(":", 1)[1] if ":" in args.judge else args.judge
    judge = JU.make_judge(args.judge)
    sys.stderr.write(f"judging {len(items)} items with {model_label} (cached) ...\n")
    scores = JU.score_items_cached(
        judge,
        [{"id": it["id"], "source": it["source"], "explanation": it["explanation"]} for it in items],
        cache,
        model_label=model_label,
    )

    rows: list[G.Row] = []
    n_override = n_add = 0
    for it in items:
        m = M.evaluate(it["source"], it["explanation"])
        s = scores[it["id"]]
        c = RF.combine(
            lexical_harder=m.harder_than_source,
            lexical_delta=m.delta,
            lexical_jargon=len(m.jargon),
            judge_score=s["score"],
            judge_q3=s["q3"],
        )
        if m.harder_than_source and not c.harder:
            n_override += 1
        if c.harder and not m.harder_than_source:
            n_add += 1
        rows.append(
            G.Row(
                passage_id=it["passage_id"],
                category=it["category"],
                tier=it["tier"],
                model=it["model"],
                delta=m.delta,
                harder_than_source=c.harder,
                n_jargon=1 if c.jargon else 0,
                jargon_lemmas=[h.lemma for h in m.jargon],
                judge_score=s["score"],
            )
        )

    result = G.evaluate_gate(rows)
    print(RP.render(rows, result, prompt_version=tp.CURRENT_PROMPT_VERSION, coverage_flags=0))
    print(f"\nfix #1 effect: judge OVERRODE {n_override} borderline lexical-harder FPs; ADDED {n_add} register catches")
    if args.out:
        json.dump(
            {"passed": result.passed, "n_items": result.n_items, "n_harder": result.n_harder,
             "median_delta": result.median_delta, "n_undefined_hard": result.n_undefined_hard,
             "per_category_harder": result.per_category_harder, "n_override": n_override, "n_add": n_add},
            open(args.out, "w", encoding="utf-8"), indent=2,
        )
    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

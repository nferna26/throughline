#!/usr/bin/env python3
"""Plain-language eval runner (CORE-1169 part 1).

For each passage x {brief,deep} x {model}, get the tutor explanation from a backend,
score source + explanation (lexical delta + jargon, optional judge), and emit a
per-item table + per-category breakdown + a single red/green headline. Exits NON-ZERO
on any hard-gate failure, so a prompt change cannot silently regress.

Default backends are OFFLINE recorded fixtures (the deterministic gate needs no
network/keys). Point --backend at anthropic/local for a live run.

Examples:
  # offline baseline (recorded current-prompt outputs incl. the communistic failure):
  python run_eval.py --baseline
  # live run, both tiers, both models:
  python run_eval.py --models 'anthropic:claude-sonnet-4-6' 'local:my-8b' --judge none
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from plaineval import backends as be  # noqa: E402
from plaineval import gate as G  # noqa: E402
from plaineval import judge as JU  # noqa: E402
from plaineval import metrics  # noqa: E402
from plaineval import report as RP  # noqa: E402
from plaineval import tutor_prompt as tp  # noqa: E402

DATASET = os.path.join(HERE, "dataset", "passages.json")
BASELINE_FIXTURES = os.path.join(HERE, "fixtures", "baseline_recorded.json")


def load_passages(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["passages"]


def model_label_of(spec: str) -> str:
    if spec.startswith("recorded:"):
        return spec.split(":", 2)[2] if spec.count(":") >= 2 else "sonnet"
    return spec.split(":", 1)[0]


def run(args: argparse.Namespace) -> int:
    passages = load_passages(args.dataset)
    if args.types:
        passages = [p for p in passages if p["type"] in args.types]

    backends = [be.make_backend(s) for s in args.models]
    model_labels = [model_label_of(s) for s in args.models]
    judge = JU.make_judge(args.judge)

    lenses = args.lenses
    tiers = args.tiers

    rows: list[G.Row] = []
    coverage_flags = 0
    n_missing = 0

    for p in passages:
        source = p["text"]
        for tier in tiers:
            for backend, mlabel in zip(backends, model_labels):
                for lens in lenses:
                    expl = backend.explain(
                        passage_id=p["id"],
                        lens=lens,
                        tier=tier,
                        selection=source,
                        book_title=p["source_title"],
                        author=p.get("author"),
                    )
                    if expl is None:
                        n_missing += 1
                        continue
                    m = metrics.evaluate(source, expl)
                    if m.source_low_coverage or m.expl_low_coverage:
                        coverage_flags += 1
                    j = judge.score(source, expl) if judge else None
                    rows.append(
                        G.Row(
                            passage_id=p["id"],
                            category=p["type"],
                            tier=tier,
                            model=mlabel,
                            delta=m.delta,
                            harder_than_source=m.harder_than_source,
                            n_jargon=len(m.jargon),
                            jargon_lemmas=[h.lemma for h in m.jargon],
                            judge_score=(j.score if j else None),
                        )
                    )

    thresholds = G.load_thresholds()
    result = G.evaluate_gate(rows, thresholds)
    print(RP.render(rows, result, prompt_version=tp.CURRENT_PROMPT_VERSION, coverage_flags=coverage_flags))
    if n_missing:
        print(f"\n(note: {n_missing} passage x lens x tier x model combinations had no recorded explanation and were skipped)")

    # Persist machine-readable results for diffing across prompt iterations.
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "prompt_version": tp.CURRENT_PROMPT_VERSION,
                    "passed": result.passed,
                    "n_items": result.n_items,
                    "n_harder": result.n_harder,
                    "median_delta": result.median_delta,
                    "n_undefined_hard": result.n_undefined_hard,
                    "per_category_harder": result.per_category_harder,
                    "rows": [vars(r) for r in rows],
                },
                fh,
                indent=2,
            )
        print(f"\nwrote {args.out}")

    if args.expect_fail:  # baseline mode asserts the gate CATCHES the failure
        if result.passed:
            print("\nBASELINE ERROR: expected the gate to FAIL on the current prompt, but it passed.")
            return 3
        print("\nBASELINE OK: the gate correctly flags the current prompt as RED.")
        return 0
    return 0 if result.passed else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Plain-language tutor eval harness (CORE-1169 part 1)")
    ap.add_argument("--dataset", default=DATASET)
    ap.add_argument("--models", nargs="+", default=None, help="backend specs; default = recorded baseline")
    ap.add_argument("--lenses", nargs="+", default=["explain", "historical", "vocabulary", "socratic"])
    ap.add_argument("--tiers", nargs="+", default=["brief", "deep"])
    ap.add_argument("--types", nargs="+", default=None, help="restrict to these difficulty types")
    ap.add_argument("--judge", default="none", help="'none' | 'gemini' | 'openai' | 'local'")
    ap.add_argument("--out", default=None, help="write machine-readable results JSON")
    ap.add_argument("--baseline", action="store_true", help="offline baseline over recorded current-prompt fixtures; asserts RED")
    args = ap.parse_args()

    if args.baseline:
        args.models = [f"recorded:{BASELINE_FIXTURES}:sonnet", f"recorded:{BASELINE_FIXTURES}:local"]
        args.expect_fail = True
        if args.out is None:
            args.out = os.path.join(HERE, "reports", "baseline.json")
    else:
        args.expect_fail = False
        if args.models is None:
            args.models = [f"recorded:{BASELINE_FIXTURES}:sonnet", f"recorded:{BASELINE_FIXTURES}:local"]

    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())

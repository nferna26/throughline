#!/usr/bin/env python3
"""Re-score a persisted run's per-item outputs with the CURRENT scorer (no model
calls), and optionally diff against the LEGACY scorer from a git ref so the scorer's
effect is isolated from the model's.

Why this exists (CORE-1169 part 1b): the first live run came back RED (753/960
harder-than-source) but did not persist its per-item explanations, so its verdict
could not be re-scored after the scorer bugs were found. `run_eval.py` now writes an
`items` array (source + explanation per cell); this script re-scores it.

  # re-score a captured run with the fixed scorer
  python rescore.py --run reports/run.json

  # isolate the SCORER's effect: same text, legacy scorer vs fixed scorer
  python rescore.py --run reports/run.json --legacy-ref claude/plain-language-eval

The legacy comparison scores the SAME captured text with both scorers, so any change
in harder/median/jargon is purely the scorer fix (the model output is held fixed). The
original 753/960 run's text was not saved, so reproduce its apples-to-apples buggy
baseline by capturing a fresh run with `run_eval.py --out` and passing it here.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from plaineval import gate as G  # noqa: E402


def _load_items(run_path: str) -> list[dict]:
    with open(run_path, encoding="utf-8") as fh:
        data = json.load(fh)
    items = data.get("items")
    if not items:
        raise SystemExit(
            f"{run_path} has no 'items' array (source+explanation per cell). It was "
            "produced before per-item persistence existed; re-capture with "
            "`run_eval.py --out` (now re-scorable) and pass that file."
        )
    return items


def _score_with(metrics_mod, items: list[dict]) -> list[G.Row]:
    rows: list[G.Row] = []
    for it in items:
        m = metrics_mod.evaluate(it["source"], it["explanation"])
        rows.append(
            G.Row(
                passage_id=it["passage_id"],
                category=it["category"],
                tier=it["tier"],
                model=it["model"],
                delta=m.delta,
                harder_than_source=m.harder_than_source,
                n_jargon=len(m.jargon),
                jargon_lemmas=[h.lemma for h in m.jargon],
            )
        )
    return rows


def _legacy_metrics(ref: str):
    """Materialize the plaineval package at a git ref into a temp dir and import its
    metrics module under a unique name, so the OLD scorer runs unmodified."""
    pkgdir = os.path.join(HERE, "plaineval")
    files = [f for f in os.listdir(pkgdir) if f.endswith(".py")]
    tmp = tempfile.mkdtemp(prefix="plaineval_legacy_")
    legacy_pkg = os.path.join(tmp, "plaineval_legacy")
    os.makedirs(legacy_pkg)
    for f in files:
        rel = f"eval/plain-language/plaineval/{f}"
        try:
            blob = subprocess.check_output(["git", "show", f"{ref}:{rel}"], cwd=HERE)
        except subprocess.CalledProcessError as exc:
            raise SystemExit(f"could not read {rel} at git ref {ref!r}: {exc}") from exc
        with open(os.path.join(legacy_pkg, f), "wb") as out:
            out.write(blob)
    # The vendor lexicon (if any) and thresholds.json live one level up; the legacy
    # jargon module reads ../thresholds.json relative to its own file, which resolves
    # into the temp dir. Copy the CURRENT thresholds so the legacy run uses the same
    # gate config and only the SCORER differs. (Legacy hardcoded HARD_ZIPF=3.0 anyway.)
    shutil.copy(os.path.join(HERE, "thresholds.json"), os.path.join(tmp, "thresholds.json"))
    sys.path.insert(0, tmp)
    return importlib.import_module("plaineval_legacy.metrics"), tmp


def _summary(rows: list[G.Row]) -> dict:
    res = G.evaluate_gate(rows)
    return {
        "n_items": res.n_items,
        "n_harder": res.n_harder,
        "median_delta": round(res.median_delta, 4),
        "n_undefined_hard": res.n_undefined_hard,
        "per_category_harder": res.per_category_harder,
        "headline": res.headline,
    }


def _print_summary(label: str, s: dict) -> None:
    print(f"\n{label}")
    print(f"  harder-than-source : {s['n_harder']}/{s['n_items']}")
    print(f"  median delta       : {s['median_delta']:+.4f}")
    print(f"  undefined-hard     : {s['n_undefined_hard']}")
    print(f"  per-category harder: {s['per_category_harder']}")
    print(f"  headline           : {s['headline']}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Re-score a captured run; optional legacy diff.")
    ap.add_argument("--run", required=True, help="run.json with an 'items' array")
    ap.add_argument("--legacy-ref", default=None, help="git ref of the pre-fix scorer to diff against")
    ap.add_argument("--out", default=None, help="write the fixed-scorer rows JSON")
    args = ap.parse_args()

    items = _load_items(args.run)
    from plaineval import metrics as fixed_metrics

    fixed_rows = _score_with(fixed_metrics, items)
    fixed = _summary(fixed_rows)

    if args.legacy_ref:
        legacy_metrics, tmp = _legacy_metrics(args.legacy_ref)
        # Re-import the fixed package state is unaffected; legacy is a separate package.
        legacy_rows = _score_with(legacy_metrics, items)
        legacy = _summary(legacy_rows)
        print("=" * 70)
        print(f"SCORER-NOISE ISOLATION  (same {len(items)} captured outputs, two scorers)")
        print("=" * 70)
        _print_summary(f"LEGACY scorer ({args.legacy_ref}):", legacy)
        _print_summary("FIXED scorer (this branch):", fixed)
        d_harder = legacy["n_harder"] - fixed["n_harder"]
        d_jargon = legacy["n_undefined_hard"] - fixed["n_undefined_hard"]
        print("\nDELTA (legacy - fixed; how much the SCORER bugs inflated the verdict):")
        print(f"  harder-than-source : -{d_harder}  ({legacy['n_harder']} -> {fixed['n_harder']})")
        print(f"  median delta       : {legacy['median_delta']:+.4f} -> {fixed['median_delta']:+.4f}")
        print(f"  undefined-hard     : -{d_jargon}  ({legacy['n_undefined_hard']} -> {fixed['n_undefined_hard']})")
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("=" * 70)
        print(f"RE-SCORE (fixed scorer) over {len(items)} captured outputs")
        print("=" * 70)
        _print_summary("FIXED scorer (this branch):", fixed)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"summary": fixed, "rows": [vars(r) for r in fixed_rows]}, fh, indent=2)
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

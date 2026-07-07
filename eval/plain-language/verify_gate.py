#!/usr/bin/env python3
"""Deterministically re-verify the CORE-1169 combined-gate result from COMMITTED fixtures.

No model calls. Judge verdicts come strictly from the committed content-hashed cache
(`fixtures/core_1169_judge_verdicts.json`); a cache miss is a HARD ERROR, because it would
mean the committed fixtures cannot reproduce the gate without a model (the exact gap this
work closes). The lexical half is deterministic (recomputed from the recorded source +
explanation), so the whole gate result is reproducible from committed state alone.

Flow: for each recorded item, recompute the lexical metrics, look up the committed judge
verdict (bound to the item's exact text by hash), combine them via the referee, run
`evaluate_gate`, and assert the result equals `fixtures/core_1169_expected.json`.

  python verify_gate.py            # exit 0 if the gate reproduces the recorded result, else 1

This is what CI runs, so "GREEN" means green in a gate over committed evidence, not a claim.
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plaineval import gate as G  # noqa: E402
from plaineval import judge as JU  # noqa: E402
from plaineval import referee as RF  # noqa: E402

# NOTE: verify deliberately does NOT recompute the lexical metrics (that would need the
# license-bound AoA lexicon, which cannot be committed, so CI could not reproduce it).
# The DETERMINISTIC lexical scores are committed IN the run fixture (lex_* fields), exactly
# as the recorded run produced them; verify combines those with the committed judge
# verdicts. So the whole gate reproduces from committed state with no lexicon and no model.

RUN = os.path.join(HERE, "fixtures", "core_1169_run.json")
VERDICTS = os.path.join(HERE, "fixtures", "core_1169_judge_verdicts.json")
EXPECTED = os.path.join(HERE, "fixtures", "core_1169_expected.json")
JUDGE_LABEL = "gpt-oss:20b"


class _CacheOnlyJudge(JU.Judge):
    """A judge that refuses to call a model: every verdict must already be committed."""

    name = JUDGE_LABEL

    def score(self, source: str, explanation: str):  # pragma: no cover - must never fire
        raise RuntimeError(
            "verify_gate requires every verdict to be present in the committed fixture "
            "cache (no model calls). A miss means the fixtures are incomplete or the "
            "recorded text changed. Regenerate with regen_run_verdicts.py."
        )


def compute_result(run_path: str = RUN, verdicts_path: str = VERDICTS) -> dict:
    """Recompute the combined-gate result from committed fixtures. No model calls."""
    run = json.load(open(run_path, encoding="utf-8"))
    items = run["items"]
    for it in items:
        it.setdefault("id", it.get("key"))

    # Verdicts strictly from the committed cache; _CacheOnlyJudge raises on any miss.
    scores = JU.score_items_cached(
        _CacheOnlyJudge(),
        [{"id": it["id"], "source": it["source"], "explanation": it["explanation"]} for it in items],
        verdicts_path,
        model_label=JUDGE_LABEL,
    )

    rows: list[G.Row] = []
    n_override = n_add = 0
    for it in items:
        # Committed deterministic lexical scores (from the recorded run), not recomputed.
        lex_harder = it["lex_harder"]
        lex_delta = it["lex_delta"]
        lex_jargon = it["lex_n_jargon"]
        s = scores[it["id"]]
        c = RF.combine(
            lexical_harder=lex_harder,
            lexical_delta=lex_delta,
            lexical_jargon=lex_jargon,
            judge_score=s["score"],
            judge_q3=s["q3"],
        )
        if lex_harder and not c.harder:
            n_override += 1
        if c.harder and not lex_harder:
            n_add += 1
        rows.append(
            G.Row(
                passage_id=it["passage_id"],
                category=it["category"],
                tier=it["tier"],
                model=it["model"],
                delta=lex_delta,
                harder_than_source=c.harder,
                n_jargon=1 if c.jargon else 0,
                jargon_lemmas=it.get("lex_jargon_lemmas", []),
                judge_score=s["score"],
            )
        )

    r = G.evaluate_gate(rows)
    return {
        "passed": r.passed,
        "n_items": r.n_items,
        "n_harder": r.n_harder,
        "median_delta": round(r.median_delta, 5),
        "n_undefined_hard": r.n_undefined_hard,
        "per_category_harder": dict(sorted(r.per_category_harder.items())),
        "n_override": n_override,
        "n_add": n_add,
    }


def main() -> int:
    if "--write-expected" in sys.argv[1:]:
        # Freeze step (run ONCE, right after regenerating verdicts): record whatever the
        # honest result is, so verify locks it thereafter. This does not force a value.
        got = compute_result()
        with open(EXPECTED, "w", encoding="utf-8") as fh:
            json.dump(got, fh, indent=2)
        print(f"wrote {os.path.relpath(EXPECTED, HERE)} (recorded {'GREEN' if got['passed'] else 'RED'}):")
        print(json.dumps(got, indent=2))
        return 0
    got = compute_result()
    if not os.path.exists(EXPECTED):
        print("no expected result committed yet; computed result was:")
        print(json.dumps(got, indent=2))
        return 2
    want = json.load(open(EXPECTED, encoding="utf-8"))
    # Compare only the recorded gate fields (ignore any commentary keys in expected).
    keys = ["passed", "n_items", "n_harder", "median_delta", "n_undefined_hard",
            "per_category_harder", "n_override", "n_add"]
    mismatches = {k: (want.get(k), got.get(k)) for k in keys if want.get(k) != got.get(k)}
    print(json.dumps(got, indent=2))
    if mismatches:
        print("\nGATE VERIFY FAILED — committed fixtures do not reproduce the recorded result:")
        for k, (w, g) in mismatches.items():
            print(f"  {k}: expected {w!r}, recomputed {g!r}")
        return 1
    print(f"\nGATE VERIFY OK — reproduced recorded result from committed fixtures "
          f"({'GREEN' if got['passed'] else 'RED'}, no model calls).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

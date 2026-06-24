"""The regression gate (handoff 2.6). Deterministic; independent of any model/judge.

A prompt iteration PASSES only if, across all items (passage x tier x model):
  - 0 explanations harder than their source (count of delta > 0 == 0);
  - median lexical delta <= median_delta_max (explanations meaningfully easier);
  - 0 undefined introduced-hard-words (jargon detector);
  - per category: no difficulty type with > per_category_max_harder harder items.

The judge is secondary and never auto-fails the headline on its own. The harness
exits non-zero on any hard-gate failure so a prompt edit cannot silently regress.
"""

from __future__ import annotations

import json
import os
import statistics
from dataclasses import dataclass, field

_THRESHOLDS_PATH = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "thresholds.json"))


def load_thresholds(path: str | None = None) -> dict:
    with open(path or _THRESHOLDS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


@dataclass
class Row:
    """One scored item carried into the gate (flattened from the runner)."""

    passage_id: str
    category: str
    tier: str
    model: str
    delta: float
    harder_than_source: bool
    n_jargon: int
    jargon_lemmas: list[str] = field(default_factory=list)
    judge_score: float | None = None


@dataclass
class Condition:
    name: str
    passed: bool
    detail: str


@dataclass
class GateResult:
    passed: bool
    conditions: list[Condition]
    n_items: int
    n_harder: int
    median_delta: float
    n_undefined_hard: int
    per_category_harder: dict[str, int]
    judge_pass_rate: float | None
    failing_items: list[Row]

    @property
    def headline(self) -> str:
        return "GREEN (pass)" if self.passed else "RED (fail)"


def evaluate_gate(rows: list[Row], thresholds: dict | None = None) -> GateResult:
    th = (thresholds or load_thresholds())["gate"]
    jt = (thresholds or load_thresholds()).get("judge", {})

    n = len(rows)
    deltas = [r.delta for r in rows]
    median_delta = statistics.median(deltas) if deltas else 0.0
    harder = [r for r in rows if r.harder_than_source]
    n_harder = len(harder)
    n_jargon = sum(r.n_jargon for r in rows)

    per_cat: dict[str, int] = {}
    for r in harder:
        per_cat[r.category] = per_cat.get(r.category, 0) + 1
    worst_cat_over = [c for c, k in per_cat.items() if k > th["per_category_max_harder"]]

    conds: list[Condition] = []
    c1 = n_harder <= th["max_harder_than_source"]
    conds.append(Condition("zero_harder_than_source", c1, f"{n_harder} harder (allowed {th['max_harder_than_source']})"))
    c2 = median_delta <= th["median_delta_max"]
    conds.append(Condition("median_delta", c2, f"median {median_delta:.3f} (must be <= {th['median_delta_max']})"))
    c3 = n_jargon <= th["max_undefined_hard_words"]
    conds.append(Condition("zero_undefined_hard_words", c3, f"{n_jargon} undefined hard words (allowed {th['max_undefined_hard_words']})"))
    c4 = len(worst_cat_over) == 0
    conds.append(Condition("per_category", c4, f"over-limit categories: {worst_cat_over or 'none'}"))

    # Judge: secondary / flag-only. Reported, but only contributes to the headline
    # via the lexical conditions above; a judge shortfall flags for human review.
    judged = [r.judge_score for r in rows if r.judge_score is not None]
    judge_pass_rate = None
    if judged:
        ok = sum(1 for s in judged if s >= jt.get("min_score", 4))
        judge_pass_rate = ok / len(judged)
        flagged = judge_pass_rate < jt.get("min_pass_rate", 0.9)
        conds.append(Condition("judge_advisory", not flagged, f"pass rate {judge_pass_rate:.2f} (flag-only, target >= {jt.get('min_pass_rate', 0.9)})"))

    # Only the lexical/jargon conditions are HARD gates.
    passed = c1 and c2 and c3 and c4

    failing = sorted(
        [r for r in rows if r.harder_than_source or r.n_jargon > 0],
        key=lambda r: (-r.delta, -r.n_jargon),
    )
    return GateResult(
        passed=passed,
        conditions=conds,
        n_items=n,
        n_harder=n_harder,
        median_delta=median_delta,
        n_undefined_hard=n_jargon,
        per_category_harder=per_cat,
        judge_pass_rate=judge_pass_rate,
        failing_items=failing,
    )

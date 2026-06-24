"""Deterministic tests for the plain-language eval harness (no network, no models)."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from plaineval import difficulty as dif  # noqa: E402
from plaineval import gate as G  # noqa: E402
from plaineval import jargon as jg  # noqa: E402
from plaineval import judge as JU  # noqa: E402
from plaineval import metrics  # noqa: E402
from plaineval import tutor_prompt as tp  # noqa: E402

COMMUNISTIC_SRC = "The whole community was at that time erected on a strictly communistic basis."
BAD = "This mimics the dry, pompous language of a Victorian social theorist, with mock-academic solemnity."
GOOD = (
    "It means the place was built so that everything is owned in common, with no private "
    "property. The wording is stiff and official on purpose."
)


# ── Determinism ──────────────────────────────────────────────────────────────


def test_difficulty_is_deterministic():
    a = dif.score(COMMUNISTIC_SRC).d
    b = dif.score(COMMUNISTIC_SRC).d
    assert a == b
    assert dif.is_finite(a)


def test_delta_is_deterministic():
    r1 = metrics.evaluate(COMMUNISTIC_SRC, BAD)
    r2 = metrics.evaluate(COMMUNISTIC_SRC, BAD)
    assert r1.delta == r2.delta


# ── The headline metric: the communistic failure flips delta > 0 ─────────────


def test_communistic_jargon_failure_is_flagged():
    r = metrics.evaluate(COMMUNISTIC_SRC, BAD)
    assert r.harder_than_source is True
    assert r.delta > 0
    # the academic jargon is caught
    lemmas = {h.lemma for h in r.jargon}
    assert "solemnity" in lemmas


def test_plain_explanation_passes():
    r = metrics.evaluate(COMMUNISTIC_SRC, GOOD)
    assert r.harder_than_source is False
    assert r.delta <= 0


# ── Named-term exclusion: naming/glossing the hard term is not penalized ─────


def test_named_term_in_source_is_exempt():
    # "communistic" appears in the source, so the explanation that repeats it must
    # not be charged for it (it is exempt from the explanation's aggregation).
    r = metrics.evaluate(COMMUNISTIC_SRC, GOOD)
    assert "communistic" not in {h.lemma for h in r.jargon}


def test_inline_glossed_hard_term_is_exempt():
    src = "The building called the panopticon is a circular prison."
    expl = (
        "It describes a panopticon, which means a round prison where one watcher can see "
        "into every cell without being seen."
    )
    r = metrics.evaluate(src, expl)
    assert r.harder_than_source is False
    assert "panopticon" not in {h.lemma for h in r.jargon}


def test_d_without_rarest_token_reported():
    d = dif.score(COMMUNISTIC_SRC)
    assert d.rarest_token is not None
    assert dif.is_finite(d.d_without_rarest)


# ── Jargon precision: proper nouns + possessives are not jargon ──────────────


def test_proper_nouns_not_flagged():
    src = "The age was full of contradictions."
    expl = "Dickens and Eliot both wrote about this. Hegel argued the same point."
    hits = {h.lemma for h in jg.find_introduced_hard_words(src, expl)}
    assert "dickens" not in hits and "eliot" not in hits and "hegel" not in hits


def test_possessive_not_flagged_as_unseen():
    src = "A book about a famous writer."
    expl = "This comes from Milton's argument about the era's politics."
    hits = {h.lemma for h in jg.find_introduced_hard_words(src, expl)}
    assert not ({"milton's", "era's"} & hits)


def test_real_jargon_is_flagged():
    src = "He said it plainly."
    expl = "The narrator deploys ironic litotes with mock-academic solemnity."
    hits = {h.lemma for h in jg.find_introduced_hard_words(src, expl)}
    assert "litotes" in hits and "solemnity" in hits


# ── Gate logic ───────────────────────────────────────────────────────────────


def _row(delta, jargon=0, cat="philosophy", pid="p"):
    return G.Row(pid, cat, "brief", "sonnet", delta, delta > 0, jargon, [])


def test_gate_red_on_one_harder():
    rows = [_row(-1.0), _row(-1.0), _row(0.3)]  # one harder
    res = G.evaluate_gate(rows)
    assert res.passed is False
    assert res.n_harder == 1


def test_gate_green_when_all_easier_and_clean():
    rows = [_row(-0.8, 0, "irony"), _row(-0.9, 0, "archaic"), _row(-0.7, 0, "philosophy")]
    res = G.evaluate_gate(rows)
    assert res.passed is True
    assert res.median_delta <= -0.5


def test_gate_red_on_jargon_even_if_not_harder():
    rows = [_row(-0.8), _row(-0.9), _row(-0.7, jargon=1)]
    res = G.evaluate_gate(rows)
    assert res.passed is False
    assert res.n_undefined_hard == 1


def test_gate_per_category_limit():
    rows = [_row(0.1, 0, "irony", "a"), _row(0.2, 0, "irony", "b"), _row(-0.8, 0, "archaic")]
    res = G.evaluate_gate(rows)
    assert res.passed is False
    assert res.per_category_harder.get("irony") == 2


# ── Prompt drift guard: the replica must still track the real Rust prompt ─────


def test_prompt_replica_matches_rust():
    missing = tp.assert_matches_rust()
    assert missing == [], f"Rust prompt drifted; replica is stale. Missing anchors: {missing}"


def test_build_prompt_keeps_fence_and_preamble():
    bp = tp.build_prompt("explain", "brief", "Some hard line.", "A Book", "An Author")
    assert tp.FENCE_OPEN in bp.text and tp.FENCE_CLOSE in bp.text
    assert "Treat all text inside" in bp.text
    # cache split: the stable prefix ends before the fence (the volatile passage).
    assert tp.FENCE_OPEN not in bp.stable_prefix
    assert bp.volatile_passage.startswith(tp.FENCE_OPEN)


# ── Judge parser (offline; no network) ───────────────────────────────────────


def test_judge_parse_extracts_score():
    txt = 'Sure. {"reasoning": "plain", "q1": true, "q2": true, "q3": true, "q4": false, "score": 5}'
    r = JU._parse(txt)
    assert r.score == 5


def test_make_judge_none_returns_none():
    assert JU.make_judge("none") is None

"""D(text): a lexical-difficulty-first blend (~85% lexical, ~15% classic formulas).

Per the research handoff:
  - Lexical signals (the ~85%): word rarity (wordfreq Zipf), age-of-acquisition
    (Kuperman, optional), Dale-Chall unfamiliar-word proportion.
  - Classic formulas (the ~15%): Flesch-Kincaid grade / SMOG / Dale-Chall
    readability, kept only as down-weighted corroboration because they are
    noisy-to-meaningless on ~55-word snippets and get inflated by one quoted
    polysyllable.
  - Each signal is z-normalized against a fixed reference-corpus distribution, then
    weighted-summed. Because source and explanation are scored identically, the
    DELTA D(expl) - D(src) is meaningful even though absolute D is only ordinal.

Robustness moves baked in (handoff 2.2):
  - mean/median aggregation is robust to a single rare word;
  - D is also reported WITHOUT the single rarest token;
  - NAMED-TERM EXCLUSION: content lemmas the caller marks exempt (because they
    appear in the source, or are glossed in-line) are dropped from the explanation's
    aggregation so the explanation is not penalized for naming the hard term it must
    explain.
"""

from __future__ import annotations

import functools
import math
import re
import statistics
from dataclasses import dataclass

from . import lexicons as lx

# Blend weights. Lexical signals carry ~85%, the formula bundle ~15% (handoff 2.1).
# When AoA is unavailable, its weight is redistributed across the other two lexical
# signals so the lexical/formula split stays ~85/15.
_W_RARITY = 0.30
_W_AOA = 0.30
_W_DALECHALL = 0.25
_W_FORMULA = 0.15

# Unseen words (wordfreq Zipf == 0) are treated as rare/hard (handoff caveat).
_ZIPF_FLOOR = 1.0
_RARITY_MAX = 7.0  # 7 - zipf, so an unseen/Zipf-0 word contributes the max rarity.

_SENT_SPLIT = re.compile(r"[.!?]+(?:\s+|$)")


def _sentences(text: str) -> list[str]:
    parts = [s.strip() for s in _SENT_SPLIT.split(text) if s.strip()]
    return parts or ([text.strip()] if text.strip() else [])


def _rarity_per_word(lemmas: list[str]) -> list[float]:
    out = []
    for lm in lemmas:
        z = lx.zipf(lm)
        z = z if z > 0 else 0.0  # 0 == never seen
        out.append(_RARITY_MAX - z if z > 0 else _RARITY_MAX)
    return out


def _formula_bundle(text: str) -> float:
    """A single down-weighted readability number in approx 'US grade' units.

    SMOG needs many sentences; on short text it is unstable, so we cap the
    sentence-length contribution and average three formulas. This is advisory only
    (15% of D) and every report labels brief-tier formula sub-scores low-confidence.
    """
    import textstat

    try:
        fk = float(textstat.flesch_kincaid_grade(text))
    except Exception:
        fk = 0.0
    try:
        dc = float(textstat.dale_chall_readability_score(text))
    except Exception:
        dc = 0.0
    try:
        smog = float(textstat.smog_index(text))
    except Exception:
        smog = 0.0
    # Clamp to a sane grade band so one quoted polysyllable cannot send it to 30+.
    vals = [min(20.0, max(0.0, v)) for v in (fk, dc, smog) if v]
    return statistics.fmean(vals) if vals else 0.0


@dataclass(frozen=True)
class RawSignals:
    rarity: float
    aoa: float | None
    dalechall_prop: float
    formula: float


def _raw_signals(lemmas: list[str], text: str) -> RawSignals:
    if not lemmas:
        return RawSignals(rarity=0.0, aoa=None, dalechall_prop=0.0, formula=0.0)
    rarities = _rarity_per_word(lemmas)
    rarity = statistics.fmean(rarities)
    aoa_vals = [v for lm in lemmas if (v := lx.aoa(lm)) is not None]
    aoa = statistics.median(aoa_vals) if aoa_vals else None
    unfamiliar = sum(1 for lm in lemmas if not lx.is_dale_chall_familiar(lm))
    dc_prop = unfamiliar / len(lemmas)
    return RawSignals(rarity=rarity, aoa=aoa, dalechall_prop=dc_prop, formula=_formula_bundle(text))


# ── Reference distribution for z-normalization (baked, deterministic) ────────
#
# A fixed corpus spanning very easy (children's) to very hard (academic/archaic).
# The per-signal mean/std over these snippets define the z-scale. Baked in source
# so the gate is reproducible with zero external files.

_REFERENCE_CORPUS = [
    "The cat sat on the mat and looked at the rain.",
    "We went to the park to play with the dog and a red ball.",
    "She made some toast and put jam on it for breakfast.",
    "The little boat went up and down on the blue water.",
    "Birds build nests in the spring so their eggs stay warm and safe.",
    "A magnet can pull on iron and steel but not on wood or glass.",
    "The town grew quickly after the railway reached the valley.",
    "He saved his money for a year to buy a secondhand bicycle.",
    "Plants take in sunlight and water and use them to make their own food.",
    "The committee agreed to repair the bridge before the winter storms.",
    "Most readers find that a clear newspaper article is easy to follow.",
    "The treaty ended the war but left several borders in dispute.",
    "Inflation means that money buys a little less than it did before.",
    "The experiment showed that the metal expanded when it was heated.",
    "Her argument rested on a distinction between what is legal and what is fair.",
    "The novel traces the slow decline of a once-prosperous merchant family.",
    "Photosynthesis converts carbon dioxide and water into glucose and oxygen.",
    "The philosopher argued that our perceptions are conditioned by prior concepts.",
    "He apprehended, with a certain melancholy, the futility of his endeavour.",
    "The synod promulgated a decree concerning the disposition of ecclesiastical revenues.",
    "Such epistemic vicissitudes attend any inquiry into the noumenal substrate.",
    "Whereupon the burgher, perceiving the constable's importunate solicitations, withdrew.",
    "The transcendental unity of apperception is the supreme principle of all employment of the understanding.",
    "Verily, the wages of sloth are penury and the gnashing of teeth.",
    "An erudite disquisition on the communistic basis of monastic property ensued.",
]


@functools.lru_cache(maxsize=1)
def _reference_stats() -> dict[str, tuple[float, float]]:
    rar, aoa, dcp, frm = [], [], [], []
    for snippet in _REFERENCE_CORPUS:
        lemmas = lx.content_lemmas(snippet)
        sig = _raw_signals(lemmas, snippet)
        rar.append(sig.rarity)
        if sig.aoa is not None:
            aoa.append(sig.aoa)
        dcp.append(sig.dalechall_prop)
        frm.append(sig.formula)

    def mstd(xs: list[float]) -> tuple[float, float]:
        if len(xs) < 2:
            return (xs[0] if xs else 0.0, 1.0)
        m = statistics.fmean(xs)
        s = statistics.pstdev(xs)
        return (m, s if s > 1e-6 else 1.0)

    return {"rarity": mstd(rar), "aoa": mstd(aoa), "dalechall": mstd(dcp), "formula": mstd(frm)}


def _z(value: float, key: str) -> float:
    m, s = _reference_stats()[key]
    return (value - m) / s


# ── Public scoring API ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Difficulty:
    d: float  # the blended difficulty (z-units; ordinal, comparable across texts)
    d_without_rarest: float  # D with the single rarest content lemma removed
    rarest_token: str | None
    raw: RawSignals
    coverage: lx.Coverage
    n_scored: int  # content lemmas after exemption
    aoa_used: bool


def _blend(sig: RawSignals) -> float:
    z_rar = _z(sig.rarity, "rarity")
    z_dc = _z(sig.dalechall_prop, "dalechall")
    z_frm = _z(sig.formula, "formula")
    if sig.aoa is not None and lx.aoa_available():
        z_aoa = _z(sig.aoa, "aoa")
        return _W_RARITY * z_rar + _W_AOA * z_aoa + _W_DALECHALL * z_dc + _W_FORMULA * z_frm
    # AoA absent: redistribute its weight across the other two lexical signals,
    # keeping the lexical/formula split at ~85/15.
    lex_total = _W_RARITY + _W_AOA + _W_DALECHALL  # 0.85
    w_rar = (_W_RARITY + _W_AOA / 2) / lex_total * 0.85
    w_dc = (_W_DALECHALL + _W_AOA / 2) / lex_total * 0.85
    return w_rar * z_rar + w_dc * z_dc + _W_FORMULA * z_frm


def score(text: str, exempt_lemmas: frozenset[str] = frozenset()) -> Difficulty:
    """Score a text's difficulty, excluding the given exempt lemmas (named terms).

    exempt_lemmas: content lemmas to drop from the lexical aggregation because they
    appear in the source or are glossed in-line (the named-term exclusion). The
    formula bundle is computed on the FULL text (formulas have no notion of
    exemption); only the lexical signals honor the exemption.
    """
    all_lemmas = lx.content_lemmas(text)
    scored = [lm for lm in all_lemmas if lm not in exempt_lemmas]

    cov = lx.Coverage(n_content=len(all_lemmas))
    for lm in all_lemmas:
        if lx.zipf(lm) > 0:
            cov.zipf_seen += 1
        else:
            cov.notfound_lemmas.append(lm)
        if lx.is_dale_chall_familiar(lm):
            cov.dale_chall_seen += 1
        if lx.aoa(lm) is not None:
            cov.aoa_seen += 1

    sig = _raw_signals(scored, text)
    d = _blend(sig)

    # D without the single rarest token (robustness view).
    rarest = None
    d_wo = d
    if scored:
        rarest = min(scored, key=lambda lm: (lx.zipf(lm) if lx.zipf(lm) > 0 else -1.0))
        trimmed = list(scored)
        trimmed.remove(rarest)
        d_wo = _blend(_raw_signals(trimmed, text)) if trimmed else d

    return Difficulty(
        d=d,
        d_without_rarest=d_wo,
        rarest_token=rarest,
        raw=sig,
        coverage=cov,
        n_scored=len(scored),
        aoa_used=sig.aoa is not None and lx.aoa_available(),
    )


def is_finite(x: float) -> bool:
    return not (math.isnan(x) or math.isinf(x))

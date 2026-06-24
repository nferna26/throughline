"""The headline metric: delta = D(explanation) - D(source), with named-term exclusion.

PASS when delta <= 0 (the explanation is no harder than the source). The explanation
is scored with the source's lemmas and any in-line-glossed lemmas EXEMPT, so it is
not penalized for naming/defining the hard term it must explain.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import difficulty as dif
from . import jargon as jg


@dataclass
class ItemResult:
    d_source: float
    d_expl: float
    delta: float
    delta_without_rarest: float
    harder_than_source: bool
    jargon: list[jg.JargonHit] = field(default_factory=list)
    n_exempt: int = 0
    source_low_coverage: bool = False
    expl_low_coverage: bool = False
    aoa_used: bool = False
    rarest_source: str | None = None
    rarest_expl: str | None = None


def evaluate(source: str, explanation: str) -> ItemResult:
    src = dif.score(source)
    exempt = jg.exempt_lemmas_for_explanation(source, explanation)
    expl = dif.score(explanation, exempt_lemmas=exempt)
    jargon = jg.find_introduced_hard_words(source, explanation)
    delta = expl.d - src.d
    return ItemResult(
        d_source=round(src.d, 4),
        d_expl=round(expl.d, 4),
        delta=round(delta, 4),
        delta_without_rarest=round(expl.d_without_rarest - src.d_without_rarest, 4),
        harder_than_source=delta > 0,
        jargon=jargon,
        n_exempt=len(exempt),
        source_low_coverage=src.coverage.low_coverage,
        expl_low_coverage=expl.coverage.low_coverage,
        aoa_used=src.aoa_used,
        rarest_source=src.rarest_token,
        rarest_expl=expl.rarest_token,
    )

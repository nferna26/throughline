"""The combined referee (CORE-1169 part 1c): lexical spine + register-sensitive judge.

The deterministic lexical delta stays the OBJECTIVE SPINE of the gate; the LLM judge
adds the REGISTER catch that word-rarity cannot see (mid-frequency words that still
read academic: "dispassionate", "posits", "reframe"). The two are combined with OR so
the judge only ever ADDS catches to the lexical gate, never silences one:

  harder  = lexical delta > 0            OR  judge plainness score <= judge_bar
  jargon  = lexical undefined-hard > 0   OR  judge says academic register present (q3 False)

This is a pure function of already-computed inputs (no I/O, no model calls), so it is
deterministic and unit-testable; the judge scores are produced + cached upstream.
"""

from __future__ import annotations

from dataclasses import dataclass

# Default plainness-score bar (1-5; 5 = perfectly plain). A judge score AT or BELOW
# the bar counts as "harder" register. Tuned against Nick's labels in calibrate.py;
# overridable per call so the calibration can sweep it.
DEFAULT_JUDGE_BAR = 3


@dataclass(frozen=True)
class CombinedVerdict:
    harder: bool
    jargon: bool
    # Provenance: which signal fired, so a report can attribute each catch.
    lexical_harder: bool
    lexical_jargon: bool
    judge_harder: bool
    judge_register: bool


def combine(
    *,
    lexical_harder: bool,
    lexical_jargon: int,
    judge_score: int | None,
    judge_q3: bool | None,
    judge_bar: int = DEFAULT_JUDGE_BAR,
) -> CombinedVerdict:
    """Combine the lexical gate with the judge into one verdict.

    lexical_harder: the lexical delta > 0 (the objective spine).
    lexical_jargon: count of lexical undefined-hard words.
    judge_score:    judge plainness 1-5, or None when no judge ran (then the judge
                    contributes nothing and the verdict is the lexical gate alone).
    judge_q3:       judge's "free of academic/literary register?" -> True means clean;
                    False means register present (a jargon catch). None = no judge.
    judge_bar:      score <= bar counts as a judge "harder" catch.
    """
    judge_harder = judge_score is not None and judge_score <= judge_bar
    judge_register = judge_q3 is False  # explicit False only; None (no judge) does not fire
    return CombinedVerdict(
        harder=bool(lexical_harder or judge_harder),
        jargon=bool(lexical_jargon > 0 or judge_register),
        lexical_harder=bool(lexical_harder),
        lexical_jargon=bool(lexical_jargon > 0),
        judge_harder=bool(judge_harder),
        judge_register=bool(judge_register),
    )

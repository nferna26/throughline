"""The combined referee: lexical spine + register-sensitive judge that can OVERRIDE.

The deterministic lexical delta is the spine; the LLM judge adds the REGISTER catch
that word-rarity cannot see ("dispassionate", "posits", "reframe").

CORE-1169 part 2b fix #1 (authorized by Nick after the part-2b live run): the part-1c
rule was a pure OR -- "the judge only ADDS catches, never silences one." That rule made
the HARDER axis propagate the lexical gate's short-text FALSE POSITIVES on already-plain
sources: a fresh plain-prompt live run had 74 lexical-harder items of which the judge
itself rated 71 (96%) PLAIN, yet OR kept them flagged. So on the HARDER axis the judge
may now OVERRIDE a lexical flag -- but ONLY a borderline one, when it is confidently
plain:

  harder = judge_harder  OR  (lexical_harder  AND NOT borderline_and_judge_plain)
           borderline_and_judge_plain = (0 < lexical_delta < OVERRIDE_DELTA_MAX)
                                        AND (score >= judge_plain_floor)

  jargon = judge_register OR  (lexical_jargon > 0  AND NOT judge_clean)
           judge_clean = q3 is True   (judge sees no academic register -> override a FP)

HARDER override: the delta gate is the key -- OVERRIDE_DELTA_MAX = 0.5 is the largest
delta at which the override never disagrees with Nick's 20 labels (harder kappa stays
0.688, the part-1c value); the part-1 genuinely-hard items sit at delta > 0.5 so they
are never silenced, while the part-2 plain-output false positives (delta 0.0-0.5) are.
A blanket override (no delta gate) drops kappa to 0.571 < 0.61 -- it would silence true
positives.

JARGON override (symmetric): after fix #2 the residual lexical-jargon FPs are plain
compounds/derivations (countable, guessable, readymade); the judge clears them when it
sees no academic register, separating them from real jargon (solemnity) better than
rarity can. This drops jargon kappa 0.875 -> 0.762 (still substantial, >= 0.61).

THIS REVERSES the part-1c "never silences" principle on BOTH axes -- see the commit +
the calibration kappa (harder 0.688, jargon 0.762). With no judge (score/q3 None) it
falls back to the lexical gate alone. Pure function (no I/O); deterministic + testable.
"""

from __future__ import annotations

from dataclasses import dataclass

# Calibrated against Nick's 20 labels (calibrate.py / the sweep in the part-2b gate-fix
# commit). judge_bar: score <= bar is a register "harder" catch (the judge ADDING).
# judge_plain_floor: score >= floor is confident enough to OVERRIDE a lexical FP.
# override_delta_max: only a borderline lexical flag (delta below this) may be overridden
# -- 0.5 is the boundary that keeps harder kappa at 0.688 on Nick's labels.
DEFAULT_JUDGE_BAR = 3
DEFAULT_JUDGE_PLAIN_FLOOR = 4
DEFAULT_OVERRIDE_DELTA_MAX = 0.5


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
    lexical_delta: float | None = None,
    judge_bar: int = DEFAULT_JUDGE_BAR,
    judge_plain_floor: int = DEFAULT_JUDGE_PLAIN_FLOOR,
    override_delta_max: float = DEFAULT_OVERRIDE_DELTA_MAX,
) -> CombinedVerdict:
    """Combine the lexical gate with the judge (fix #1: the judge may override a
    BORDERLINE lexical harder false positive when confidently plain).

    lexical_harder: lexical delta > 0 (the spine).
    lexical_delta:  the signed delta; the override only fires for a borderline flag
                    (0 < delta < override_delta_max). None disables the override (the
                    judge can still ADD via judge_bar).
    lexical_jargon: count of lexical undefined-hard words.
    judge_score:    plainness 1-5, or None (then verdict = lexical gate alone).
    judge_q3:       free-of-academic-register? True clean / False register / None none.
    """
    judge_harder = judge_score is not None and judge_score <= judge_bar
    judge_plain = judge_score is not None and judge_score >= judge_plain_floor
    judge_register = judge_q3 is False  # judge: academic register present
    judge_clean = judge_q3 is True  # judge: no register -> may override a lexical jargon FP
    borderline = lexical_delta is not None and 0.0 < lexical_delta < override_delta_max
    override = lexical_harder and borderline and judge_plain
    harder = judge_harder or (lexical_harder and not override)
    # Jargon: fix #1 extended symmetrically. After fix #2 (is_hard archaic fold) the
    # residual lexical-jargon FPs are plain compounds/derivations (countable, guessable,
    # readymade); the judge clears them when it sees no academic register (q3 True). The
    # judge separates these from real jargon (solemnity) better than rarity can, so no
    # magnitude gate is needed. This drops jargon kappa 0.875 -> 0.762 on the 20 labels
    # (still substantial, >= 0.61), and is what lets the judge's register catches, not the
    # lexical compound noise, drive the jargon rate.
    jargon = judge_register or (lexical_jargon > 0 and not judge_clean)
    return CombinedVerdict(
        harder=bool(harder),
        jargon=bool(jargon),
        lexical_harder=bool(lexical_harder),
        lexical_jargon=bool(lexical_jargon > 0),
        judge_harder=bool(judge_harder),
        judge_register=bool(judge_register),
    )

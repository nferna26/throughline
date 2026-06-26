"""Introduced-hard-word (jargon) detection + the in-line definition heuristic.

A violation is a content word the EXPLANATION introduces that is (a) absent from the
source, (b) hard (rare / late-acquired / off the Dale-Chall list), and (c) NOT
defined in the same sentence. The in-line gloss heuristic implements the handoff's
"if a hard term is defined in the same breath, it is not a violation" rule, and also
feeds the named-term exclusion in the difficulty delta.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from . import lexicons as lx

# A word is "hard" if any signal says so (handoff 2.3 thresholds; tunable). The
# BINARY jargon gate uses the SHARP rarity/AoA cutoff (precision matters: it is a
# hard gate). The Dale-Chall list is intentionally NOT used as a binary jargon
# trigger here, because the ~3000-word list leaves ordinary words ("overwhelm" 3.15,
# "complicate" 3.26) off it and would over-flag; Dale-Chall does its work in the
# GRADED difficulty score (difficulty.py), not in this binary gate.
#
# CORE-1169 part 1b re-audit: thresholds.json is now the single source of truth so
# the gate and its documentation cannot drift (the constants below are the fallback).
# HARD_ZIPF was lowered 3.0 -> 2.6: the 2.6-3.0 band is mid-frequency vocabulary a
# fluent adult knows (murmur 2.92, predictability 2.85, passivity 2.60, argumentation
# 2.65, ephemeral 2.99), and flagging it produced most of the binary-jargon noise in
# the live run. The canonical academic-register failures from the handoff stay flagged
# (solemnity 2.54, litotes 1.23, deontological 1.88, apperception 1.77). The mid band
# (~2.3-2.9) is inherently register-dependent: rarity alone cannot separate "solemnity"
# (jargon) from "passivity" (plain), which is precisely what the human calibration
# step measures. AoA is unavailable in this environment (Kuperman norms absent), so the
# rarity cutoff is the sole active binary signal; HARD_AOA stays documented for when
# vendor/aoa_kuperman.csv is present.
_THRESHOLDS_PATH = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "thresholds.json"))


def _load_jargon_cutoffs() -> tuple[float, float]:
    try:
        with open(_THRESHOLDS_PATH, encoding="utf-8") as fh:
            jt = json.load(fh).get("jargon", {})
        return float(jt.get("hard_zipf", 2.6)), float(jt.get("hard_aoa", 10.0))
    except (OSError, ValueError, KeyError):
        return 2.6, 10.0


HARD_ZIPF, HARD_AOA = _load_jargon_cutoffs()
# A token is treated as a proper noun (and exempt from the jargon gate, because an
# author's or place's name is not a "hard word a reader must look up") if it appears
# Title-cased away from a sentence start in the original explanation.
_PROPER_RE = re.compile(r"[A-Z][a-z]+")
# Definition cues that mean "the writer is glossing a term in this sentence".
_CUE_RE = re.compile(
    r"\b(means?|meaning|that is|in other words|i\.e\.|e\.g\.|refers? to|"
    r"which is|who is|that the|stands for|is when|are when|is called|known as|"
    r"is the|is a|is an|named|so-called)\b",
    re.IGNORECASE,
)
_SENT_SPLIT = re.compile(r"[.!?]+(?:\s+|$)")


def _rarity_zipf(lemma: str) -> float:
    """Zipf frequency, reading a plain word spelled archaically at its REAL frequency.

    CORE-1169 part 2b fix #2 (gate bug): the live models echo archaic source spelling
    ("thinke", "talke", "growe", "mixe", "develope"), which wordfreq scores as rare
    (thinke 1.06) even though the modern word is among the commonest ("think" 6.08), so
    the jargon gate flagged plain words. Fold accents and a single trailing archaic -e
    and take the MAX zipf, so the archaic spelling is read at the modern word's
    frequency. Deliberately ONLY the trailing -e (Nick's spec): the full archaic_key's
    i/y and doubled-consonant folds produce non-words ("play" -> "plai") with spurious
    low frequencies, so they are NOT used for the rarity check.
    """
    folded = lx.fold_accents(lemma).lower()
    z = lx.zipf(folded)
    if len(folded) > 3 and folded.endswith("e"):
        z = max(z, lx.zipf(folded[:-1]))
    return z


def is_hard(lemma: str) -> bool:
    z = _rarity_zipf(lemma)
    if z == 0.0:  # never seen by wordfreq -> treat as rare/hard
        return True
    if z < HARD_ZIPF:
        return True
    a = lx.aoa(lemma)
    if a is not None and a > HARD_AOA:
        return True
    return False


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_SPLIT.split(text) if s.strip()]


def proper_noun_lemmas(text: str) -> frozenset[str]:
    """Lemmas of Title-cased tokens that are NOT sentence-initial (proper nouns).

    "Dickens repeats the word fog" -> {dickens}; "Fog everywhere" -> {} (sentence
    start). Possessives are handled by the lemmatizer ("Milton's" -> milton). These
    are exempt from the jargon gate: a name is not a hard word to look up.
    """
    out: set[str] = set()
    for sent in _sentences(text):
        toks = sent.split()
        for i, raw in enumerate(toks):
            # Fold accents first so an accented capital is still recognized as a
            # proper noun ("Übermensch" -> "Ubermensch", "Brontë" -> "Bronte");
            # otherwise the leading non-ASCII letter fails the [A-Z] check and the
            # name leaks into the jargon set.
            word = lx.fold_accents(raw).strip(".,;:!?\"'()[]").split("'")[0]
            if not _PROPER_RE.fullmatch(word):
                continue
            low = word.lower()
            mid_sentence = i > 0
            # Mid-sentence Title-case is strong proper-noun evidence. A sentence-
            # initial Title-case word is a name only if its lowercase form is
            # uncommon and off the familiar list (so "Hegel"/"Kant"/"Dickens" count
            # but "The"/"Fog"/"Studies" do not).
            if mid_sentence or (lx.zipf(low) < 4.0 and not lx.is_dale_chall_familiar(low)):
                out.add(lx.lemma(low))
    return frozenset(out)


def inline_glossed_lemmas(text: str) -> frozenset[str]:
    """Content lemmas that sit in a sentence carrying a definition cue.

    Heuristic per handoff 2.2/2.3: a hard word defined in the same sentence is
    cleared. We treat every content lemma in a cue-bearing sentence as glossed
    (slightly generous, which is the safe direction: it avoids penalizing a genuine
    in-line definition; the difficulty delta and the jargon gate both rely on this).
    """
    glossed: set[str] = set()
    for sent in _sentences(text):
        if _CUE_RE.search(sent) or "(" in sent:
            glossed.update(lx.content_lemmas(sent))
    return frozenset(glossed)


@dataclass(frozen=True)
class JargonHit:
    lemma: str
    sentence: str
    zipf: float
    aoa: float | None


def find_introduced_hard_words(source: str, explanation: str) -> list[JargonHit]:
    """Undefined hard words the explanation introduces that are not in the source.

    Exemptions: words in the source, words glossed in-line, and proper nouns (names
    are not "hard words to look up"). Proper nouns that ALSO appear in the source are
    already covered, but an explanation naming the author ("Dickens") is exempt too.
    """
    src_lemmas = set(lx.content_lemmas(source))
    glossed = inline_glossed_lemmas(explanation)
    proper = proper_noun_lemmas(explanation) | proper_noun_lemmas(source)
    # Match exemption on the archaic-folded key so a word quoted from the source is
    # exempt even when its spelling varies ("talke"/"thinke" in an old passage quoted
    # in the explanation map to "talk"/"think"). Proper nouns and in-line glosses are
    # folded the same way.
    exempt_keys = {lx.archaic_key(x) for x in (src_lemmas | glossed | proper)}
    hits: list[JargonHit] = []
    seen: set[str] = set()
    for sent in _sentences(explanation):
        for lm in lx.content_lemmas(sent):
            if lm in seen or lx.archaic_key(lm) in exempt_keys:
                continue
            if is_hard(lm):
                hits.append(JargonHit(lemma=lm, sentence=sent, zipf=lx.zipf(lm), aoa=lx.aoa(lm)))
                seen.add(lm)
    return hits


def exempt_lemmas_for_explanation(source: str, explanation: str) -> frozenset[str]:
    """The named-term exclusion set (as archaic-folded keys) for scoring the
    explanation's difficulty.

    Exempt: lemmas that appear in the source, are glossed in-line, OR are proper
    nouns (a name the explanation introduces is not a difficulty the reader faces
    versus the source). Returned as `archaic_key` forms; `difficulty.score` folds each
    candidate lemma the same way before testing membership, so a quoted archaic source
    word and an introduced name are both excluded from the delta, not just from the
    binary jargon gate. This keeps the bug-1/bug-2 fixes consistent across both halves
    of the headline (delta and jargon).
    """
    src_lemmas = set(lx.content_lemmas(source))
    glossed = set(inline_glossed_lemmas(explanation))
    proper = set(proper_noun_lemmas(explanation)) | set(proper_noun_lemmas(source))
    return frozenset(lx.archaic_key(x) for x in (src_lemmas | glossed | proper))

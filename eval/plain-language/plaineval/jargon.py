"""Introduced-hard-word (jargon) detection + the in-line definition heuristic.

A violation is a content word the EXPLANATION introduces that is (a) absent from the
source, (b) hard (rare / late-acquired / off the Dale-Chall list), and (c) NOT
defined in the same sentence. The in-line gloss heuristic implements the handoff's
"if a hard term is defined in the same breath, it is not a violation" rule, and also
feeds the named-term exclusion in the difficulty delta.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import lexicons as lx

# A word is "hard" if any signal says so (handoff 2.3 thresholds; tunable). The
# BINARY jargon gate uses the SHARP rarity/AoA cutoff (precision matters: it is a
# hard gate). The Dale-Chall list is intentionally NOT used as a binary jargon
# trigger here, because the ~3000-word list leaves ordinary words ("overwhelm" 3.15,
# "complicate" 3.26) off it and would over-flag; Dale-Chall does its work in the
# GRADED difficulty score (difficulty.py), not in this binary gate.
HARD_ZIPF = 3.0  # rarer than ~1 per million -> hard
HARD_AOA = 10.0  # acquired after ~age 10
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


def is_hard(lemma: str) -> bool:
    z = lx.zipf(lemma)
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
            word = raw.strip(".,;:!?\"'()[]").split("'")[0]
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
    exempt = src_lemmas | glossed | proper
    hits: list[JargonHit] = []
    seen: set[str] = set()
    for sent in _sentences(explanation):
        for lm in lx.content_lemmas(sent):
            if lm in seen or lm in exempt:
                continue
            if is_hard(lm):
                hits.append(JargonHit(lemma=lm, sentence=sent, zipf=lx.zipf(lm), aoa=lx.aoa(lm)))
                seen.add(lm)
    return hits


def exempt_lemmas_for_explanation(source: str, explanation: str) -> frozenset[str]:
    """The named-term exclusion set for scoring the explanation's difficulty:
    lemmas that appear in the source OR are glossed in-line in the explanation."""
    return frozenset(set(lx.content_lemmas(source)) | set(inline_glossed_lemmas(explanation)))

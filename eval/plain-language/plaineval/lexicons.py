"""Offline lexicons + tokenizer/lemmatizer (loaded once).

Three lexical difficulty signals per the research handoff:
  1. word rarity   -> wordfreq Zipf frequency (bundled, offline)
  2. familiarity   -> Dale-Chall ~3000-word familiar list (textstat-bundled)
  3. age-of-acq.   -> Kuperman AoA norms (OPTIONAL; dropped in if vendor/aoa_kuperman.csv
                      is present, else the blend re-normalizes over the other two and
                      coverage is logged as 0, per the handoff's low-coverage rule)

Everything here is deterministic and network-free once installed. wordfreq ships a
frozen data snapshot, so two runs on the same input give identical scores.
"""

from __future__ import annotations

import csv
import functools
import os
import re
from dataclasses import dataclass, field

import simplemma
import wordfreq

_VENDOR = os.path.join(os.path.dirname(__file__), "..", "vendor")
_AOA_PATH = os.path.normpath(os.path.join(_VENDOR, "aoa_kuperman.csv"))

# A content word is what carries difficulty; function words (the, of, and...) are
# excluded from the lexical aggregation so a long Victorian sentence full of common
# glue words is not scored as "easy" purely on function-word density.
_STOPWORDS = frozenset(
    """a an the this that these those of to in on at by for with from into onto upon over
    under above below as is are was were be been being am do does did have has had having
    will would shall should can could may might must and or but nor so yet if then than
    because while when where which who whom whose what why how not no nor only own same
    too very s t just don now also out up down off about again further once here there all
    any both each few more most other some such it its he she they them his her their our
    your you i we me my mine ours yours theirs him us himself herself itself themselves
    myself ourselves yourself yourselves whoever whatever however whenever wherever""".split()
)

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
_POSSESSIVE_RE = re.compile(r"['’]s$")


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens; strip the possessive 's so "era's" scores as "era"
    (otherwise the apostrophe form is unseen by wordfreq and reads as rare/hard)."""
    out = []
    for m in _TOKEN_RE.finditer(text):
        w = _POSSESSIVE_RE.sub("", m.group(0).lower()).strip("'")
        if w:
            out.append(w)
    return out


@functools.lru_cache(maxsize=200_000)
def lemma(word: str) -> str:
    """Lemmatize a single token (cached). simplemma is offline + deterministic."""
    try:
        return simplemma.lemmatize(word, lang="en")
    except Exception:
        return word


def content_lemmas(text: str) -> list[str]:
    """Content-word lemmas: drop stopwords + pure-punctuation, lemmatize the rest."""
    out = []
    for tok in tokenize(text):
        if tok in _STOPWORDS:
            continue
        lm = lemma(tok)
        if lm in _STOPWORDS or len(lm) < 2:
            continue
        out.append(lm)
    return out


def zipf(word: str) -> float:
    """Zipf frequency 1..7 (lower = rarer/harder). 0.0 when wordfreq has never seen it."""
    return wordfreq.zipf_frequency(word, "en")


# ── Dale-Chall familiar-word set (textstat-bundled, MIT) ─────────────────────


@functools.lru_cache(maxsize=1)
def dale_chall_set() -> frozenset[str]:
    """The ~3000-word Dale-Chall familiar list, lemmatized for matching."""
    import textstat  # local import so the module imports even if textstat is absent

    words: set[str] = set()
    # textstat >=0.7 bundles resources/en/easy_words.txt; fall back to its API.
    base = os.path.dirname(textstat.__file__)
    path = os.path.join(base, "resources", "en", "easy_words.txt")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                w = line.strip().lower()
                if w:
                    words.add(w)
                    words.add(lemma(w))
    return frozenset(words)


def is_dale_chall_familiar(word: str) -> bool:
    return word in dale_chall_set()


# ── Kuperman age-of-acquisition (OPTIONAL) ───────────────────────────────────


@functools.lru_cache(maxsize=1)
def aoa_map() -> dict[str, float]:
    """word -> mean age-of-acquisition (years). Empty dict if the file is absent.

    Accepts a CSV with a 'Word' column and a rating column named one of
    'Rating.Mean' / 'AoA_Kup_lem' / 'AoA' (the common Kuperman/BRM headers).
    """
    if not os.path.exists(_AOA_PATH):
        return {}
    out: dict[str, float] = {}
    try:
        with open(_AOA_PATH, encoding="utf-8", errors="replace") as fh:
            reader = csv.DictReader(fh)
            cols = {c.lower(): c for c in (reader.fieldnames or [])}
            wcol = cols.get("word")
            rcol = next(
                (cols[c] for c in ("rating.mean", "aoa_kup_lem", "aoa", "aoa_kup") if c in cols),
                None,
            )
            if not wcol or not rcol:
                return {}
            for row in reader:
                w = (row.get(wcol) or "").strip().lower()
                raw = (row.get(rcol) or "").strip()
                if not w or not raw:
                    continue
                try:
                    out[w] = float(raw)
                except ValueError:
                    continue
    except Exception:
        return {}
    return out


def aoa(word: str) -> float | None:
    return aoa_map().get(word)


@dataclass
class Coverage:
    """Per-text lexicon coverage, logged so a low-coverage passage is visible."""

    n_content: int = 0
    zipf_seen: int = 0  # wordfreq Zipf > 0
    dale_chall_seen: int = 0  # on the familiar list (a coverage proxy)
    aoa_seen: int = 0
    notfound_lemmas: list[str] = field(default_factory=list)

    @property
    def zipf_cov(self) -> float:
        return self.zipf_seen / self.n_content if self.n_content else 1.0

    @property
    def aoa_cov(self) -> float:
        return self.aoa_seen / self.n_content if self.n_content else 0.0

    @property
    def low_coverage(self) -> bool:
        # Flag a passage whose words wordfreq mostly cannot place (archaic/proper
        # heavy) so its D is read with caution, per the handoff caveat.
        return self.n_content >= 4 and self.zipf_cov < 0.6


def aoa_available() -> bool:
    return len(aoa_map()) > 1000

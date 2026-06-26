"""Deterministic tests for the plain-language eval harness (no network, no models)."""

import os
import socket
import ssl
import sys
import urllib.error
from io import BytesIO

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from plaineval import backends as be  # noqa: E402
from plaineval import difficulty as dif  # noqa: E402
from plaineval import gate as G  # noqa: E402
from plaineval import jargon as jg  # noqa: E402
from plaineval import judge as JU  # noqa: E402
from plaineval import lexicons as lx  # noqa: E402
from plaineval import metrics  # noqa: E402
from plaineval import metrics as M  # noqa: E402
from plaineval import referee as RF  # noqa: E402
from plaineval import tutor_prompt as tp  # noqa: E402
import run_eval  # noqa: E402

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


# ── CORE-1169 part 1b: scorer bug fixes (calibration prerequisites) ──────────


def test_accented_names_are_not_mangled_into_jargon():
    # BUG 1: the ASCII tokenizer turned "Brontë" -> "bront" and "Übermensch" ->
    # "bermensch" (leading "Ü" dropped), unseen fragments that were flagged as
    # introduced jargon. Folding accents keeps the whole word, and the (now
    # accent-aware) proper-noun check exempts the name.
    src = "He admired the novelist and the philosopher."
    expl = "This echoes Brontë and the idea of the Übermensch, said plainly."
    hits = {h.lemma for h in jg.find_introduced_hard_words(src, expl)}
    assert not (hits & {"bront", "bermensch", "bronte", "ubermensch"}), hits


def test_accent_fold_keeps_whole_token_for_difficulty():
    # The folded token is the whole word, not a rare fragment.
    assert lx.tokenize("Brontë") == ["bronte"]
    assert lx.tokenize("Übermensch") == ["ubermensch"]
    assert lx.tokenize("naïve café") == ["naive", "cafe"]


def test_quoted_archaic_source_word_is_exempt():
    # BUG 2: a word quoted from an archaic source ("talke"/"thinke"/"olde") must be
    # exempt from the jargon gate even though its spelling is non-standard, because
    # it is present in the source. The archaic key folds the variant to match.
    src = "Under all speech lies a silence; he loved to talke and to thinke on olde things."
    expl = "It means he liked to talke and thinke about olde matters, nothing more."
    hits = {h.lemma for h in jg.find_introduced_hard_words(src, expl)}
    assert not (hits & {"talke", "thinke", "olde", "talk", "think", "old"}), hits


def test_archaic_key_folds_light_variants():
    assert lx.archaic_key("talke") == lx.archaic_key("talk")
    assert lx.archaic_key("thinke") == lx.archaic_key("think")
    assert lx.archaic_key("memorie") == lx.archaic_key("memory")
    assert lx.archaic_key("shoppe") == lx.archaic_key("shop")
    # but distinct words do not collide
    assert lx.archaic_key("litotes") != lx.archaic_key("light")


def test_midfrequency_words_are_not_flagged():
    # BUG 3: mid-frequency words a fluent adult knows were over-flagged at the old
    # 3.0 cutoff. At 2.6 they are clean.
    src = "The passage is plain."
    expl = "There is a soft murmur, a sense of passivity, and real predictability here."
    hits = {h.lemma for h in jg.find_introduced_hard_words(src, expl)}
    assert not (hits & {"murmur", "passivity", "predictability"}), hits


def test_genuinely_arcane_words_still_flagged_after_retune():
    # The canonical academic-register failures must survive the retune.
    src = "He said it plainly."
    expl = "The narrator deploys litotes with deontological solemnity and apperception."
    hits = {h.lemma for h in jg.find_introduced_hard_words(src, expl)}
    assert {"litotes", "deontological", "solemnity", "apperception"} <= hits, hits


def test_jargon_cutoffs_come_from_thresholds_json():
    # thresholds.json is the single source of truth (no drift between the documented
    # value and the code).
    import json
    import os

    path = os.path.join(os.path.dirname(jg.__file__), "..", "thresholds.json")
    with open(path, encoding="utf-8") as fh:
        jt = json.load(fh)["jargon"]
    assert jg.HARD_ZIPF == jt["hard_zipf"] == 2.6
    assert jg.HARD_AOA == jt["hard_aoa"]


def test_introduced_proper_noun_is_exempt_from_delta_and_jargon():
    # A name the explanation introduces is exempt from the difficulty delta too, not
    # just the jargon gate: it enters the named-term exclusion set, so the name itself
    # cannot push the explanation's score up. (This isolates the proper-noun fix; the
    # overall delta can still move for unrelated lexical reasons.)
    src = "The fog covers the whole city, blurring the streets."
    expl = "Dickens repeats the word fog so the whole city feels lost in grey haze."
    exempt = jg.exempt_lemmas_for_explanation(src, expl)
    assert lx.archaic_key("dickens") in exempt
    assert "dickens" not in {h.lemma for h in jg.find_introduced_hard_words(src, expl)}


# ── CORE-1169 part 1c: AoA activation + combined referee (lexical OR judge) ──


def test_hard_aoa_cutoff_comes_from_thresholds_and_is_14():
    import json

    path = os.path.join(os.path.dirname(jg.__file__), "..", "thresholds.json")
    with open(path, encoding="utf-8") as fh:
        jt = json.load(fh)["jargon"]
    assert jg.HARD_AOA == jt["hard_aoa"] == 14.0


def test_aoa_is_kept_out_of_the_difficulty_blend():
    # The delta is the objective spine; AoA hurt it on archaic sources, so the blend
    # must not use AoA even when the norms are present.
    assert dif._USE_AOA_IN_BLEND is False


def test_combine_harder_is_lexical_or_judge_below_bar():
    # Lexical spine alone fires.
    v = RF.combine(lexical_harder=True, lexical_jargon=0, judge_score=5, judge_q3=True)
    assert v.harder is True and v.lexical_harder is True and v.judge_harder is False
    # Judge catches a register case the lexical gate cleared.
    v = RF.combine(lexical_harder=False, lexical_jargon=0, judge_score=2, judge_q3=True, judge_bar=3)
    assert v.harder is True and v.judge_harder is True and v.lexical_harder is False
    # Both clear -> not harder.
    v = RF.combine(lexical_harder=False, lexical_jargon=0, judge_score=5, judge_q3=True, judge_bar=3)
    assert v.harder is False


def test_combine_jargon_judge_register_or_lexical_unless_judge_clears():
    # part 2b fix #1 (jargon axis): the judge's q3 may OVERRIDE a lexical jargon FP.
    # Lexical jargon + judge says clean (q3 True) -> overridden to NOT jargon.
    v = RF.combine(lexical_harder=False, lexical_jargon=2, judge_score=5, judge_q3=True)
    assert v.jargon is False, "a lexical jargon FP the judge calls clean must be overridden"
    # Lexical jargon + no judge -> stays (no override without a judge).
    v = RF.combine(lexical_harder=False, lexical_jargon=2, judge_score=None, judge_q3=None)
    assert v.jargon is True
    # Lexical jargon + judge says register present (q3 False) -> jargon (they agree).
    v = RF.combine(lexical_harder=False, lexical_jargon=2, judge_score=3, judge_q3=False)
    assert v.jargon is True
    # Judge's "academic register present" is still a catch even with 0 lexical jargon.
    v = RF.combine(lexical_harder=False, lexical_jargon=0, judge_score=4, judge_q3=False)
    assert v.jargon is True and v.judge_register is True and v.lexical_jargon is False
    # Clean both ways -> not jargon.
    v = RF.combine(lexical_harder=False, lexical_jargon=0, judge_score=5, judge_q3=True)
    assert v.jargon is False


def test_combine_with_no_judge_is_the_lexical_gate_alone():
    # judge_score None / judge_q3 None: the judge contributes nothing (OR with no signal).
    v = RF.combine(lexical_harder=True, lexical_jargon=0, judge_score=None, judge_q3=None)
    assert v.harder is True and v.judge_harder is False and v.judge_register is False
    v = RF.combine(lexical_harder=False, lexical_jargon=0, judge_score=None, judge_q3=None)
    assert v.harder is False and v.jargon is False


def test_combine_judge_overrides_borderline_lexical_fp(tmp_path=None):
    # CORE-1169 part 2b fix #1: the judge may OVERRIDE a BORDERLINE lexical harder flag
    # (0 < delta < override_delta_max) when confidently plain (score >= plain_floor).
    # Borderline FP + confidently plain -> overridden to NOT harder.
    v = RF.combine(lexical_harder=True, lexical_delta=0.2, lexical_jargon=0, judge_score=5, judge_q3=True)
    assert v.harder is False, "borderline lexical FP + confident-plain judge must be overridden"
    # A CLEARLY-harder lexical flag (delta beyond the gate) is NOT overridden, even if
    # the judge says plain -- this is what keeps the calibration kappa at 0.688.
    v = RF.combine(lexical_harder=True, lexical_delta=1.4, lexical_jargon=0, judge_score=5, judge_q3=True)
    assert v.harder is True, "a large lexical delta must not be silenced by the judge"
    # The judge still ADDS a register catch the lexical gate missed.
    v = RF.combine(lexical_harder=False, lexical_delta=-0.3, lexical_jargon=0, judge_score=2, judge_q3=True)
    assert v.harder is True and v.judge_harder is True
    # Borderline but judge only mildly plain (below the plain_floor) -> not overridden.
    v = RF.combine(lexical_harder=True, lexical_delta=0.2, lexical_jargon=0, judge_score=3, judge_q3=True)
    assert v.harder is True


def test_is_hard_folds_archaic_trailing_e_spelling():
    # CORE-1169 part 2b fix #2: a plain word spelled archaically (the live models echo
    # archaic sources) must be read at the modern word's frequency, not as rare jargon.
    for w in ["thinke", "talke", "growe", "mixe", "fixe", "develope", "playe"]:
        assert not jg.is_hard(w), f"{w} is a plain word spelled archaically; must not flag"
    # Genuinely hard / archaic words still flag.
    for w in ["solemnity", "litotes", "deontological", "apperception", "wend"]:
        assert jg.is_hard(w), f"{w} is genuinely hard; must still flag"


def test_judge_score_caching_avoids_recall(tmp_path):
    # A fake judge that counts calls; the cache must serve the second pass with 0 calls.
    class _CountingJudge(JU.Judge):
        name = "fake"

        def __init__(self):
            self.calls = 0

        def score(self, source, explanation):
            self.calls += 1
            return JU.JudgeResult(score=4, reasoning="ok", raw={"q1": True, "q2": True, "q3": True, "q4": False})

    items = [{"id": "a|x", "source": "s1", "explanation": "e1"}, {"id": "b|y", "source": "s2", "explanation": "e2"}]
    cache = str(tmp_path / "judge_cache.json")
    j = _CountingJudge()
    out1 = JU.score_items_cached(j, items, cache, model_label="fake")
    assert j.calls == 2 and set(out1) == {"a|x", "b|y"} and out1["a|x"]["score"] == 4
    j2 = _CountingJudge()
    out2 = JU.score_items_cached(j2, items, cache, model_label="fake")
    assert j2.calls == 0 and out2["b|y"]["q3"] is True  # served entirely from disk


def test_make_judge_is_configurable_and_never_sonnet():
    assert JU.make_judge("none") is None
    j = JU.make_judge("local:gpt-oss:20b")
    assert j.model == "gpt-oss:20b" and "sonnet" not in j.name.lower()


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


# ── Live backend request shaping (offline; fake HTTP) ────────────────────────


class _FakeResponse(BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def test_local_backend_uses_ollama_native_chat_with_thinking_disabled(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        seen["timeout"] = timeout
        seen["body"] = req.data.decode()
        return _FakeResponse(b'{"message":{"content":" Plain answer. "}}')

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    backend = be.LocalBackend("qwen3.5:latest", "http://localhost:11434/v1")
    out = backend.explain(
        passage_id="p",
        lens="explain",
        tier="brief",
        selection="A hard line.",
        book_title="Book",
        author=None,
    )

    payload = __import__("json").loads(seen["body"])
    assert out == "Plain answer."
    assert seen["url"] == "http://localhost:11434/api/chat"
    assert seen["timeout"] == 180
    assert payload["stream"] is False
    assert payload["think"] is False
    assert payload["options"] == {"temperature": 0, "num_predict": 220}
    assert payload["model"] == "qwen3.5:latest"


def test_local_backend_keeps_openai_compatible_path_for_lm_studio(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        seen["body"] = req.data.decode()
        return _FakeResponse(b'{"choices":[{"message":{"content":" Plain answer. "}}]}')

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    backend = be.LocalBackend("local-model", "http://localhost:1234/v1")
    out = backend.explain(
        passage_id="p",
        lens="explain",
        tier="deep",
        selection="A hard line.",
        book_title="Book",
        author=None,
    )

    payload = __import__("json").loads(seen["body"])
    assert out == "Plain answer."
    assert seen["url"] == "http://localhost:1234/v1/chat/completions"
    assert payload["max_tokens"] == 420
    assert "think" not in payload


def test_env_file_loader_sets_missing_values_without_overriding_shell(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "# local live eval secrets\n"
        "ANTHROPIC_API_KEY=from-file\n"
        "LOCAL_AI_BASE_URL='http://localhost:11434/v1'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-shell")
    monkeypatch.delenv("LOCAL_AI_BASE_URL", raising=False)

    run_eval.load_env_file(str(env))

    assert os.environ["ANTHROPIC_API_KEY"] == "from-shell"
    assert os.environ["LOCAL_AI_BASE_URL"] == "http://localhost:11434/v1"


def test_open_json_retries_transient_ssl_eof(monkeypatch):
    calls = {"n": 0, "sleeps": []}

    def fake_urlopen(_req, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError(ssl.SSLEOFError("eof"))
        assert timeout == 7
        return _FakeResponse(b'{"ok": true}')

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(be.time, "sleep", lambda delay: calls["sleeps"].append(delay))

    assert be._open_json("request", timeout=7, attempts=2) == {"ok": True}
    assert calls == {"n": 2, "sleeps": [1]}


def test_open_json_retries_transient_dns_failure(monkeypatch):
    calls = {"n": 0, "sleeps": []}

    def fake_urlopen(_req, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError(socket.gaierror(8, "temporary dns failure"))
        return _FakeResponse(b'{"ok": true}')

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(be.time, "sleep", lambda delay: calls["sleeps"].append(delay))

    assert be._open_json("request", attempts=2) == {"ok": True}
    assert calls == {"n": 2, "sleeps": [1]}

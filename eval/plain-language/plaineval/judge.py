"""Optional, secondary, INDEPENDENT LLM-as-judge (handoff 2.4).

A G-Eval-style 1-5 plainness rubric, scored pointwise at temperature 0. The judge
MUST be cross-family (never Claude/Sonnet, since the tutor is Sonnet) to avoid
self-preference bias (Panickssery et al. 2024; Zheng et al. 2023). It is FLAG-ONLY:
the deterministic lexical delta is the headline gate; the judge never auto-fails the
headline on its own. Offline runs use Llama-3.1-8B via a local OpenAI-compatible
server; cloud runs use Gemini or GPT.

`make_judge('none')` returns None (no judge); the harness runs the full lexical gate
without it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass

RUBRIC = (
    "You are grading how PLAIN a tutor's answer is, relative to a hard source passage. "
    "Read the SOURCE, then the ANSWER. Answer each with one short reason:\n"
    "(1) Would a reader who found the source hard understand the answer with no dictionary?\n"
    "(2) Does the answer use simpler words than the source?\n"
    "(3) Is it free of literary or academic jargon (no 'mock-academic', 'diction', 'register', 'solemnity')?\n"
    "(4) Does the answer itself need its own explanation?\n"
    "IMPORTANT: the answer is sometimes a SOCRATIC QUESTION (or a few questions) meant to point the "
    "reader back into the passage, NOT an explanation. A question is not supposed to explain anything, so "
    "do NOT score it low for 'not explaining' or for leaving the meaning open. Judge a question ONLY on "
    "whether the question itself is worded in plain, everyday language a reader could easily understand; a "
    "clear, plainly-worded question is a 5 even though it answers nothing.\n"
    "Then give an overall plainness score 1-5 (5 = perfectly plain, no harder than the source; "
    "1 = harder than the source or needs its own explanation). Judge plainness only; ignore length. "
    'Output ONLY JSON: {"reasoning": str, "q1": bool, "q2": bool, "q3": bool, "q4": bool, "score": int}.'
)


@dataclass(frozen=True)
class JudgeResult:
    score: int
    reasoning: str
    raw: dict


def _user_prompt(source: str, explanation: str) -> str:
    # The field label MUST match the rubric's wording ("the ANSWER"): a mismatched
    # "EXPLANATION:" label made the judge intermittently reply "I need the answer text
    # first" and return no JSON (a parse-failure FP). The fenced ANSWER block also makes
    # the boundary unambiguous.
    return (
        f"{RUBRIC}\n\nSOURCE PASSAGE:\n{source}\n\n"
        f"TUTOR ANSWER TO GRADE (between the lines):\n"
        f"---\n{explanation}\n---\n"
    )


def _parse(text: str) -> JudgeResult:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return JudgeResult(score=0, reasoning="unparseable judge output", raw={"text": text[:200]})
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return JudgeResult(score=0, reasoning="invalid judge JSON", raw={"text": text[:200]})
    score = int(obj.get("score", 0)) if str(obj.get("score", "")).strip().lstrip("-").isdigit() else 0
    return JudgeResult(score=max(0, min(5, score)), reasoning=str(obj.get("reasoning", "")), raw=obj)


class Judge:
    """Base: subclasses implement _complete(prompt)->str at temperature 0."""

    name = "judge"

    def _complete(self, prompt: str) -> str:  # pragma: no cover - network
        raise NotImplementedError

    def score(self, source: str, explanation: str) -> JudgeResult:
        return _parse(self._complete(_user_prompt(source, explanation)))


class GeminiJudge(Judge):
    name = "gemini"

    def __init__(self, model: str = "gemini-2.5-pro"):
        self.model = model
        self._key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    def _complete(self, prompt: str) -> str:  # pragma: no cover - network
        if not self._key:
            raise RuntimeError("GEMINI_API_KEY not set")
        import urllib.request

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={self._key}"
        body = json.dumps(
            {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0}}
        ).encode()
        req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.load(resp)
        return data["candidates"][0]["content"]["parts"][0]["text"]


class OpenAICompatJudge(Judge):
    """GPT (cloud) or Llama-3.1-8B (local) via an OpenAI-compatible endpoint."""

    def __init__(self, name: str, model: str, base_url: str, api_key_env: str | None):
        self.name = name
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._key = os.environ.get(api_key_env) if api_key_env else None
        self._needs_key = bool(api_key_env)

    def _complete(self, prompt: str) -> str:  # pragma: no cover - network
        if self._needs_key and not self._key:
            raise RuntimeError(f"API key for judge {self.name} not set")
        import urllib.request

        headers = {"content-type": "application/json"}
        if self._key:
            headers["authorization"] = f"Bearer {self._key}"
        body = json.dumps(
            {
                "model": self.model,
                "temperature": 0,
                # The verdict is a short JSON object; a cap stops a local model that
                # occasionally runs away (repetition loop) on a hard item from generating
                # thousands of tokens and blowing the timeout. Ample for the JSON.
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            }
        ).encode()
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=body, headers=headers)
        # The slowest deep-tier local generations run past a tight 120s cap; keep a
        # generous default (overridable) so a genuine slow item completes rather than
        # failing spuriously. Only affects live judging, never the cached/offline path.
        timeout = int(os.environ.get("JUDGE_HTTP_TIMEOUT_SECONDS", "300"))
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
        return data["choices"][0]["message"]["content"]


def make_judge(spec: str) -> Judge | None:
    """spec: 'none' | 'gemini[:model]' | 'gpt[:model]' | 'local[:model]'.

    The local judge is configurable via env: JUDGE_BASE_URL (default the Ollama
    OpenAI-compatible endpoint) and JUDGE_MODEL (default a cross-family open model).
    It must NOT be the tutor family (Sonnet) nor the local tutor (qwen3.5), to avoid
    self-preference bias; gpt-oss / gemma are good offline cross-family choices.
    """
    spec = (spec or "none").strip()
    low = spec.lower()
    if low in ("none", "off", ""):
        return None
    model_override = spec.split(":", 1)[1] if ":" in spec else None
    if low.startswith("gemini"):
        return GeminiJudge(model_override or "gemini-2.5-pro")
    if low.startswith("openai") or low.startswith("gpt"):
        return OpenAICompatJudge("openai", model_override or "gpt-4o", "https://api.openai.com/v1", "OPENAI_API_KEY")
    if low.startswith("local"):
        base = os.environ.get("JUDGE_BASE_URL") or os.environ.get("LOCAL_AI_BASE_URL") or "http://localhost:11434/v1"
        model = model_override or os.environ.get("JUDGE_MODEL") or "gpt-oss:20b"
        return OpenAICompatJudge(f"local:{model}", model, base, None)
    raise ValueError(f"unknown judge spec: {spec}")


# ── Offline-reproducible scoring: cache verdicts keyed by (model, rubric, item, text) ──


def verdict_text_sha(source: str, explanation: str) -> str:
    """Content hash binding a verdict to the EXACT text it graded.

    CORE-1169 audit fix: the cache was keyed by "<model>|<id>" alone, so if the text for
    an id ever changed (a re-run with a different tutor output, or a cache shared across
    runs) a stale verdict silently graded the WRONG text. Hashing (source + explanation)
    into the key, and storing that hash in the verdict, makes that impossible: a changed
    text is a new key, and a hit whose stored hash disagrees is re-judged, never trusted.
    """
    h = hashlib.sha256()
    h.update(source.encode("utf-8"))
    h.update(b"\x00")
    h.update(explanation.encode("utf-8"))
    return h.hexdigest()[:16]


# Fingerprint of the grading rubric. Folding it into the cache key means a rubric change
# (e.g. the Fix #2 Socratic rewrite) never collides with old-rubric verdicts: they are
# distinct keys, so a shipping-rubric run never silently reuses a stale-rubric verdict.
# This is what lets a committed cache prove it is the shipping rubric's verdicts.
RUBRIC_FP = hashlib.sha256(RUBRIC.encode("utf-8")).hexdigest()[:8]


def score_items_cached(judge: Judge, items: list[dict], cache_path: str, *, model_label: str | None = None) -> dict:
    """Score items with the judge, persisting each verdict so re-runs need no model.

    items: dicts with 'id', 'source', 'explanation'. Returns {id: verdict-dict} where
    verdict-dict is {score, q1..q4, reasoning, _text_sha, _rubric_fp}. The cache (a JSON
    file) is keyed by "<model>|<rubric_fp>|<id>|<text_sha>", so a verdict is bound to the
    exact text AND rubric that produced it: a changed passage/answer or a changed rubric
    is a cache MISS (re-judged), never a silent wrong-text hit. Only missing items call
    the model, so the same worksheet/run calibrates offline forever once scored.
    """
    label = model_label or getattr(judge, "name", "judge")
    cache: dict = {}
    if os.path.exists(cache_path):
        try:
            with open(cache_path, encoding="utf-8") as fh:
                cache = json.load(fh)
        except (OSError, ValueError):
            cache = {}
    changed = False
    out: dict = {}
    for it in items:
        tsha = verdict_text_sha(it["source"], it["explanation"])
        key = f"{label}|{RUBRIC_FP}|{it['id']}|{tsha}"
        cached = cache.get(key)
        # Defense in depth: a hit whose stored hash disagrees with the current text would
        # mean grading the wrong text, so it is not trusted -> re-judge.
        if cached is None or cached.get("_text_sha") != tsha:
            res = judge.score(it["source"], it["explanation"])
            cache[key] = {
                "score": res.score,
                "q1": res.raw.get("q1"),
                "q2": res.raw.get("q2"),
                "q3": res.raw.get("q3"),
                "q4": res.raw.get("q4"),
                "reasoning": res.reasoning,
                "_text_sha": tsha,
                "_rubric_fp": RUBRIC_FP,
            }
            changed = True
        out[it["id"]] = cache[key]
    if changed:
        os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump(cache, fh, indent=2)
    return out

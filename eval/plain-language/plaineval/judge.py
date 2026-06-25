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

import json
import os
import re
from dataclasses import dataclass

RUBRIC = (
    "You are grading how PLAIN an explanation is, relative to a hard source passage. "
    "Read the SOURCE, then the EXPLANATION. Answer each with one short reason:\n"
    "(1) Would a reader who found the source hard understand the explanation with no dictionary?\n"
    "(2) Does the explanation use simpler words than the source?\n"
    "(3) Is it free of literary or academic jargon (no 'mock-academic', 'diction', 'register', 'solemnity')?\n"
    "(4) Does the explanation itself need its own explanation?\n"
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
    return f"{RUBRIC}\n\nSOURCE:\n{source}\n\nEXPLANATION:\n{explanation}\n"


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
            {"model": self.model, "temperature": 0, "messages": [{"role": "user", "content": prompt}]}
        ).encode()
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
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


# ── Offline-reproducible scoring: cache judge verdicts keyed by (model, item) ────


def score_items_cached(judge: Judge, items: list[dict], cache_path: str, *, model_label: str | None = None) -> dict:
    """Score items with the judge, persisting each verdict so re-runs need no model.

    items: dicts with 'id', 'source', 'explanation'. Returns {id: verdict-dict} where
    verdict-dict is {score, q1..q4, reasoning}. The cache (a JSON file) is keyed by
    "<model>|<id>", so the same worksheet calibrates offline forever once scored, and a
    different judge model gets its own cache entries. Only missing items hit the model.
    """
    import json
    import os

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
        key = f"{label}|{it['id']}"
        if key not in cache:
            res = judge.score(it["source"], it["explanation"])
            cache[key] = {
                "score": res.score,
                "q1": res.raw.get("q1"),
                "q2": res.raw.get("q2"),
                "q3": res.raw.get("q3"),
                "q4": res.raw.get("q4"),
                "reasoning": res.reasoning,
            }
            changed = True
        out[it["id"]] = cache[key]
    if changed:
        os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump(cache, fh, indent=2)
    return out

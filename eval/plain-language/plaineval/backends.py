"""Explanation backends: where the tutor's answer comes from for each item.

  - recorded  (default, OFFLINE): read explanations from a fixtures JSON. This is how
    the baseline + the deterministic gate run with no network, no keys, no cost.
  - anthropic (LIVE): Claude Sonnet via the Messages API (the cloud tier).
  - local     (LIVE): an OpenAI-compatible local server (LM Studio / Ollama) for the
    local-model tier.

The live backends build the REAL prompt via tutor_prompt.build_prompt and call at
temperature 0 with a per-tier max_tokens cap (mirroring the app's ceiling). They are
only used when explicitly selected and configured; the harness's headline gate is
the deterministic lexical delta and does not require them.
"""

from __future__ import annotations

import json
import os
from typing import Protocol

from . import tutor_prompt as tp

# Per-tier output ceilings, mirroring the app's max_tokens backstop intent.
_MAX_TOKENS = {"brief": 220, "deep": 420}


class Backend(Protocol):
    name: str

    def explain(self, *, passage_id: str, lens: str, tier: str, selection: str, book_title: str, author: str | None) -> str | None:
        ...


class RecordedBackend:
    """Reads explanations from a fixtures file keyed by 'passage_id|lens|tier|model'."""

    def __init__(self, path: str, model_label: str):
        self.name = f"recorded:{model_label}"
        self.model_label = model_label
        with open(path, encoding="utf-8") as fh:
            blob = json.load(fh)
        self._data: dict[str, str] = blob.get("explanations", blob)

    def _key(self, passage_id: str, lens: str, tier: str) -> str:
        return f"{passage_id}|{lens}|{tier}|{self.model_label}"

    def explain(self, *, passage_id: str, lens: str, tier: str, selection: str, book_title: str, author: str | None) -> str | None:
        return self._data.get(self._key(passage_id, lens, tier))


class AnthropicBackend:
    """Claude Sonnet via the Messages API (live cloud tier). Needs ANTHROPIC_API_KEY."""

    def __init__(self, model: str = "claude-sonnet-4-6"):
        self.name = f"anthropic:{model}"
        self.model = model
        self._key = os.environ.get("ANTHROPIC_API_KEY")

    def explain(self, *, passage_id: str, lens: str, tier: str, selection: str, book_title: str, author: str | None) -> str | None:
        if not self._key:
            raise RuntimeError("ANTHROPIC_API_KEY not set; cannot run the live anthropic backend")
        import urllib.request

        built = tp.build_prompt(lens, tier, selection, book_title, author)
        body = json.dumps(
            {
                "model": self.model,
                "max_tokens": _MAX_TOKENS[tier],
                "temperature": 0,
                "messages": [{"role": "user", "content": built.text}],
            }
        ).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "x-api-key": self._key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.load(resp)
        parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
        return "".join(parts).strip() or None


class LocalBackend:
    """An OpenAI-compatible local server (LM Studio default port). Live local tier."""

    def __init__(self, model: str = "local-model", base_url: str | None = None):
        self.name = f"local:{model}"
        self.model = model
        self.base_url = (base_url or os.environ.get("LOCAL_AI_BASE_URL") or "http://localhost:1234/v1").rstrip("/")

    def explain(self, *, passage_id: str, lens: str, tier: str, selection: str, book_title: str, author: str | None) -> str | None:
        import urllib.request

        built = tp.build_prompt(lens, tier, selection, book_title, author)
        body = json.dumps(
            {
                "model": self.model,
                "temperature": 0,
                "max_tokens": _MAX_TOKENS[tier],
                "messages": [{"role": "user", "content": built.text}],
            }
        ).encode()
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.load(resp)
        return (data["choices"][0]["message"]["content"] or "").strip() or None


def make_backend(spec: str) -> Backend:
    """spec: 'recorded:<fixtures.json>:<model_label>' | 'anthropic[:model]' | 'local[:model]'."""
    if spec.startswith("recorded:"):
        _, path, *rest = spec.split(":", 2)
        label = rest[0] if rest else "sonnet"
        return RecordedBackend(path, label)
    if spec.startswith("anthropic"):
        model = spec.split(":", 1)[1] if ":" in spec else "claude-sonnet-4-6"
        return AnthropicBackend(model)
    if spec.startswith("local"):
        model = spec.split(":", 1)[1] if ":" in spec else "local-model"
        return LocalBackend(model)
    raise ValueError(f"unknown backend spec: {spec}")

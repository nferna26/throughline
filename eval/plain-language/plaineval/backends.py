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
import socket
import ssl
import time
import urllib.request
from urllib.parse import urlparse
from typing import Protocol

from . import tutor_prompt as tp

# Per-tier output ceilings, mirroring the app's max_tokens backstop intent.
_MAX_TOKENS = {"brief": 220, "deep": 420}
_HTTP_TIMEOUT_SECONDS = int(os.environ.get("PLAINEVAL_HTTP_TIMEOUT_SECONDS", "180"))
_HTTP_RETRIES = int(os.environ.get("PLAINEVAL_HTTP_RETRIES", "3"))


def _open_json(req, *, timeout: int = _HTTP_TIMEOUT_SECONDS, attempts: int = _HTTP_RETRIES):
    import urllib.error
    import urllib.request

    last_exc: BaseException | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504}:
                raise
            last_exc = exc
            retry_after = exc.headers.get("Retry-After")
            delay = int(retry_after) if retry_after and retry_after.isdigit() else 2**attempt
        except TimeoutError as exc:
            last_exc = exc
            delay = 2**attempt
        except urllib.error.URLError as exc:
            if not isinstance(exc.reason, (TimeoutError, ConnectionResetError, socket.gaierror, ssl.SSLError)):
                raise
            last_exc = exc
            delay = 2**attempt
        if attempt < attempts - 1:
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc


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
        data = _open_json(req)
        parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
        return "".join(parts).strip() or None


class LocalBackend:
    """A local server (LM Studio/OpenAI-compatible, or Ollama native). Live local tier."""

    def __init__(self, model: str = "local-model", base_url: str | None = None):
        self.name = f"local:{model}"
        self.model = model
        self.base_url = (base_url or os.environ.get("LOCAL_AI_BASE_URL") or "http://localhost:1234/v1").rstrip("/")
        parsed = urlparse(self.base_url)
        self._is_ollama = parsed.hostname in {"localhost", "127.0.0.1", "::1"} and parsed.port == 11434

    def explain(self, *, passage_id: str, lens: str, tier: str, selection: str, book_title: str, author: str | None) -> str | None:
        built = tp.build_prompt(lens, tier, selection, book_title, author)
        if self._is_ollama:
            body = json.dumps(
                {
                    "model": self.model,
                    "stream": False,
                    "think": False,
                    "options": {"temperature": 0, "num_predict": _MAX_TOKENS[tier]},
                    "messages": [{"role": "user", "content": built.text}],
                }
            ).encode()
            req = urllib.request.Request(
                f"{self.base_url.removesuffix('/v1')}/api/chat",
                data=body,
                headers={"content-type": "application/json"},
            )
            data = _open_json(req)
            return (data["message"]["content"] or "").strip() or None

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
        data = _open_json(req)
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

"""DeepSeek: one short JSON call per clicked bubble.

The system prompt is a fixed constant placed first so DeepSeek's automatic
prefix cache applies; only the bubble text varies. Bump PROMPT_VERSION
whenever the prompt changes so cached explanations are not reused.
"""

from __future__ import annotations

import json

import httpx

PROMPT_VERSION = 1
API_URL = "https://api.deepseek.com/chat/completions"
MAX_NOTES = 5
MAX_SUGGESTIONS = 4

SYSTEM_PROMPT = """You help an English-speaking learner read Japanese manga. The user message is the text of ONE speech bubble (OCR output).
Reply with a single JSON object, in English, with exactly this schema:
{"translation": "natural English translation of the bubble",
 "notes": [{"focus": "the Japanese fragment", "explanation": "why it is written this way"}],
 "suggestions": [{"word": "dictionary form", "reading": "hiragana reading", "meaning": "short English gloss"}]}
Rules:
- notes: 2-5 items about grammar and structure (particles, conjugations, contractions, sentence-final particles, omitted subjects, nuance and tone), not plain word glosses. One or two sentences each.
- suggestions: 2-4 words or set phrases from this bubble most worth learning, in dictionary form; skip trivial words (これ, は, です) and onomatopoeia.
- Keep it short. Output JSON only."""


class ExplainError(Exception):
    def __init__(self, kind: str, detail: str = "") -> None:
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind


def build_request(text: str, model: str) -> dict:
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 700,
        "stream": False,
    }


def parse_explanation(content: str) -> dict:
    try:
        data = json.loads(content)
    except (TypeError, ValueError) as e:
        raise ExplainError("bad_response", "invalid JSON") from e
    if not isinstance(data, dict) or not isinstance(data.get("translation"), str):
        raise ExplainError("bad_response", "missing translation")
    notes = [
        {"focus": str(n.get("focus", "")), "explanation": str(n.get("explanation", ""))}
        for n in data.get("notes") or []
        if isinstance(n, dict) and n.get("explanation")
    ][:MAX_NOTES]
    suggestions = [
        {"word": str(s["word"]), "reading": str(s["reading"]), "meaning": str(s.get("meaning", ""))}
        for s in data.get("suggestions") or []
        if isinstance(s, dict) and s.get("word") and s.get("reading")
    ][:MAX_SUGGESTIONS]
    return {"translation": data["translation"], "notes": notes, "suggestions": suggestions}


class DeepSeekClient:
    def __init__(self, api_key: str | None, model: str, transport: httpx.BaseTransport | None = None) -> None:
        self._api_key = api_key
        self._model = model
        self._http = httpx.Client(timeout=30.0, transport=transport)

    def explain(self, text: str) -> dict:
        if not self._api_key:
            raise ExplainError("no_api_key")
        try:
            resp = self._http.post(
                API_URL,
                json=build_request(text, self._model),
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
        except httpx.TransportError as e:
            raise ExplainError("network", str(e)) from e
        if resp.status_code in (401, 403):
            raise ExplainError("auth")
        if resp.status_code == 402:
            raise ExplainError("no_balance")
        if resp.status_code == 429:
            raise ExplainError("rate_limited")
        if resp.status_code != 200:
            raise ExplainError("bad_response", f"HTTP {resp.status_code}")
        try:
            content = resp.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as e:
            raise ExplainError("bad_response", "unexpected payload") from e
        return parse_explanation(content)

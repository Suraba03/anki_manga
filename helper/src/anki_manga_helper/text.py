"""Furigana (ruby) for bubble text and bolding a target word in a sentence."""

from __future__ import annotations

import html
import re
from functools import lru_cache

import jaconv

_KANJI = re.compile(r"[㐀-鿿々〆豈-﫿]")
_KANA_ONLY = re.compile(r"^[぀-ヿー]+$")


@lru_cache(maxsize=1)
def _tagger():
    import fugashi

    return fugashi.Tagger()


def _reading(word) -> str | None:
    kana = getattr(word.feature, "kana", None) or getattr(word.feature, "pron", None)
    if not kana or kana == "*":
        return None
    return jaconv.kata2hira(kana)


def _split_okurigana(surface: str, reading: str) -> list[tuple[str, str | None]]:
    """Strip kana shared at the start/end of surface and reading; ruby only the core."""
    s_hira = jaconv.kata2hira(surface)
    pre = 0
    while pre < min(len(surface), len(reading)) and s_hira[pre] == reading[pre] and not _KANJI.match(surface[pre]):
        pre += 1
    suf = 0
    while (
        suf < min(len(surface), len(reading)) - pre
        and s_hira[-1 - suf] == reading[-1 - suf]
        and not _KANJI.match(surface[-1 - suf])
    ):
        suf += 1
    core_s = surface[pre : len(surface) - suf]
    core_r = reading[pre : len(reading) - suf]
    out: list[tuple[str, str | None]] = []
    if pre:
        out.append((surface[:pre], None))
    if core_s:
        out.append((core_s, core_r or None))
    if suf:
        out.append((surface[len(surface) - suf :], None))
    return out


def segments(text: str) -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    pos = 0
    for word in _tagger()(text):
        surface = word.surface
        start = text.find(surface, pos)
        if start > pos:  # whitespace the tokenizer dropped
            out.append((text[pos:start], None))
        pos = (start if start >= 0 else pos) + len(surface)
        reading = _reading(word) if _KANJI.search(surface) else None
        if reading:
            out.extend(_split_okurigana(surface, reading))
        else:
            out.append((surface, None))
    if pos < len(text):
        out.append((text[pos:], None))
    return out


def ruby_html(text: str) -> str:
    return "".join(
        f"<ruby>{html.escape(s)}<rt>{html.escape(r)}</rt></ruby>" if r else html.escape(s)
        for s, r in segments(text)
    )


def bold_word(text: str, word: str) -> str:
    if word and word in text:
        return html.escape(text).replace(html.escape(word), f"<b>{html.escape(word)}</b>")
    parts = []
    for tok in _tagger()(text):
        lemma = getattr(tok.feature, "lemma", None)
        base = getattr(tok.feature, "orthBase", None)
        esc = html.escape(tok.surface)
        parts.append(f"<b>{esc}</b>" if word and word in (lemma, base) else esc)
    return "".join(parts)

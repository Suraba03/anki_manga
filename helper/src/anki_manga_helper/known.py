"""Which words a deck already has (works with any note type, no configuration)."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

import jaconv

_RT_RP = re.compile(r"<(rt|rp)\b[^>]*>.*?</\1>", re.S | re.I)
_ANKI_FURI = re.compile(r"\[[^\]]*\]")
_TAGS = re.compile(r"<[^>]+>")
_KANA_ONLY = re.compile(r"^[぀-ヿー]+$")


def strip_field(value: str) -> str:
    value = _RT_RP.sub("", value)
    value = _ANKI_FURI.sub("", value)
    value = _TAGS.sub("", value)
    value = html.unescape(value).replace("\xa0", " ")
    return re.sub(r"\s+", "", value)


@dataclass
class KnownWords:
    words: set[str] = field(default_factory=set)
    kana_entries: set[str] = field(default_factory=set)

    @classmethod
    def from_notes(cls, notes: list[dict], our_model: str) -> "KnownWords":
        known = cls()
        for n in notes:
            fields = n.get("fields", {})
            if n.get("modelName") == our_model and "Word" in fields:
                raw = fields["Word"]["value"]
            else:
                first = min(fields.values(), key=lambda f: f.get("order", 0), default=None)
                if first is None:
                    continue
                raw = first["value"]
            known.add(strip_field(raw))
        return known

    def add(self, word: str) -> None:
        if not word:
            return
        self.words.add(word)
        if _KANA_ONLY.match(word):
            self.kana_entries.add(jaconv.kata2hira(word))

    def is_known(self, word: str, reading: str) -> bool:
        return word in self.words or jaconv.kata2hira(reading or "") in self.kana_entries

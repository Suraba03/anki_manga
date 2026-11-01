"""AnkiConnect client: decks, our note type, known words, adding cards."""

from __future__ import annotations

import base64

import httpx

from .known import KnownWords

NOTE_TYPE = "Manga Mining (anki_manga)"
FIELDS = [
    "Word",
    "Reading",
    "Meaning",
    "Sentence",
    "SentenceFurigana",
    "SentenceTranslation",
    "Explanation",
    "Picture",
    "Source",
]

_FRONT = """<div class="word">{{Word}}</div>
<div class="sentence">{{Sentence}}</div>"""

_BACK = """{{FrontSide}}
<hr id=answer>
<div class="reading">{{Reading}}</div>
<div class="meaning">{{Meaning}}</div>
<div class="furigana">{{SentenceFurigana}}</div>
<div class="translation">{{SentenceTranslation}}</div>
<div class="explanation">{{Explanation}}</div>
<div class="picture">{{Picture}}</div>
<div class="source">{{Source}}</div>"""

_CSS = """.card { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; font-size: 20px;
  text-align: center; color: #222; background: #fafaf7; line-height: 1.5; }
.word { font-size: 42px; margin: 12px 0; }
.sentence { font-size: 24px; }
.sentence b { color: #c0392b; }
.reading { font-size: 22px; color: #555; }
.meaning { font-size: 20px; margin-bottom: 10px; }
.furigana { font-size: 22px; } .furigana rt { color: #c0392b; font-size: 11px; }
.translation { font-style: italic; color: #555; margin: 8px 0; }
.explanation { text-align: left; font-size: 15px; max-width: 560px; margin: 10px auto;
  border-left: 3px solid #f5a524; padding-left: 10px; }
.picture img { max-width: 100%; max-height: 420px; border-radius: 6px; margin-top: 10px; }
.source { font-size: 12px; color: #999; margin-top: 8px; }
.nightMode .card, .card.nightMode { background: #1e1e1e; color: #eee; }"""

BATCH = 500


class AnkiUnreachable(Exception):
    pass


class AnkiError(Exception):
    pass


class AnkiClient:
    def __init__(self, url: str = "http://127.0.0.1:8765", transport: httpx.BaseTransport | None = None) -> None:
        self._http = httpx.Client(base_url=url, timeout=3.0, transport=transport)

    def _call(self, action: str, **params):
        try:
            resp = self._http.post("", json={"action": action, "version": 6, "params": params})
            data = resp.json()
        except (httpx.TransportError, ValueError) as e:
            raise AnkiUnreachable(str(e)) from e
        if data.get("error"):
            msg = str(data["error"])
            raise AnkiError("duplicate" if "duplicate" in msg else msg)
        return data.get("result")

    def deck_names(self) -> list[str]:
        return sorted(self._call("deckNames"))

    def ensure_note_type(self) -> bool:
        if NOTE_TYPE in self._call("modelNames"):
            return False
        self._call(
            "createModel",
            modelName=NOTE_TYPE,
            inOrderFields=FIELDS,
            css=_CSS,
            isCloze=False,
            cardTemplates=[{"Name": "Recognition", "Front": _FRONT, "Back": _BACK}],
        )
        return True

    def known_words(self, deck: str) -> KnownWords:
        ids = self._call("findNotes", query=f'deck:"{deck}"')
        notes: list[dict] = []
        for i in range(0, len(ids), BATCH):
            notes.extend(self._call("notesInfo", notes=ids[i : i + BATCH]))
        return KnownWords.from_notes(notes, NOTE_TYPE)

    def add_card(self, deck: str, fields: dict[str, str], picture_jpeg: bytes | None, picture_name: str) -> int:
        note = {
            "deckName": deck,
            "modelName": NOTE_TYPE,
            "fields": fields,
            "options": {"allowDuplicate": False, "duplicateScope": "deck"},
            "tags": ["anki_manga"],
        }
        if picture_jpeg:
            note["picture"] = [
                {"data": base64.b64encode(picture_jpeg).decode(), "filename": picture_name, "fields": ["Picture"]}
            ]
        return self._call("addNote", note=note)

import threading

import numpy as np

from anki_manga_helper.boxes import Bubble


def make_bubbles(n):
    return [Bubble(id=i, box=(10.0 * i, 0.0, 10.0 * i + 5, 5.0), vertical=True, font_size=5.0, lines=[]) for i in range(n)]


class FakeEngine:
    def __init__(self, n_bubbles=2, block_first=False):
        self.ready = True
        self.error = None
        self.calls = []
        self.detect_calls = 0
        self.n_bubbles = n_bubbles
        self.release = threading.Event()
        if not block_first:
            self.release.set()
        self.started = threading.Event()

    def detect(self, img):
        self.detect_calls += 1
        return make_bubbles(self.n_bubbles)

    def ocr(self, img, bubble):
        self.started.set()
        self.release.wait(5)
        self.calls.append(bubble.id)
        return f"t{bubble.id}"


IMG = np.zeros((10, 10, 3), dtype=np.uint8)


import cv2  # noqa: E402

from anki_manga_helper.anki import AnkiError, AnkiUnreachable  # noqa: E402,F401
from anki_manga_helper.known import KnownWords  # noqa: E402


def png_bytes(seed=0):
    img = np.full((60, 80, 3), 255, dtype=np.uint8)
    img[seed % 60, :, :] = 0
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


class FakeAnki:
    def __init__(self, known=(), down=False, duplicate=False):
        self.known = list(known)
        self.down = down
        self.duplicate = duplicate
        self.added = []
        self.ensured = 0

    def _check(self):
        if self.down:
            raise AnkiUnreachable("down")

    def deck_names(self):
        self._check()
        return ["manga mining"]

    def ensure_note_type(self):
        self._check()
        self.ensured += 1
        return False

    def known_words(self, deck):
        self._check()
        k = KnownWords()
        for w in self.known:
            k.add(w)
        return k

    def add_card(self, deck, fields, picture_jpeg, picture_name):
        self._check()
        if self.duplicate:
            raise AnkiError("duplicate")
        self.added.append({"deck": deck, "fields": fields, "picture_jpeg": picture_jpeg, "picture_name": picture_name})
        return 99


class FakeDeepSeek:
    def __init__(self):
        self.calls = 0
        self.fail_with = None

    def explain(self, text):
        self.calls += 1
        if self.fail_with:
            err, self.fail_with = self.fail_with, None
            raise err
        return {
            "translation": f"EN:{text}",
            "notes": [{"focus": "な", "explanation": "explains"}],
            "suggestions": [
                {"word": "道具", "reading": "どうぐ", "meaning": "tool"},
                {"word": "角度", "reading": "かくど", "meaning": "angle"},
            ],
        }

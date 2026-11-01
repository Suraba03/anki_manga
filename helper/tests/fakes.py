import threading

import numpy as np

from anki_manga_helper.boxes import Bubble


def make_bubbles(n):
    return [Bubble(id=i, box=(10.0 * i, 0.0, 10.0 * i + 5, 5.0), vertical=True, font_size=5.0, lines=[]) for i in range(n)]


class FakeEngine:
    def __init__(self, n_bubbles=2, block_first=False):
        self.ready = True
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

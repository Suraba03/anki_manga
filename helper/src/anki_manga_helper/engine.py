"""Bubble detection (comic-text-detector via mokuro) and per-bubble OCR (manga_ocr).

Model calls share one GPU, so every call holds ``self._lock``.
"""

from __future__ import annotations

import threading

import cv2
import numpy as np
from PIL import Image

from .boxes import Bubble, merge_duplicates, reading_order

OCR_PAD = 4


def decode_image(data: bytes) -> np.ndarray:
    """Decode image bytes to an RGB array; ValueError if undecodable."""
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR) if arr.size else None
    if img is None:
        raise ValueError("undecodable image")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


class Engine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._detector = None
        self._mocr = None
        self.ready = False
        self.error: str | None = None

    def load(self) -> None:
        import torch
        from comic_text_detector.inference import TextDetector
        from manga_ocr import MangaOcr
        from mokuro.cache import cache

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        with self._lock:
            self._detector = TextDetector(
                model_path=cache.comic_text_detector, input_size=1024, device=device, act="leaky"
            )
            self._mocr = MangaOcr("kha-white/manga-ocr-base")
        self.ready = True

    def detect(self, img: np.ndarray) -> list[Bubble]:
        with self._lock:
            _, _, blks = self._detector(img, refine_mode=1, keep_undetected_mask=True)
        bubbles = [
            Bubble(
                id=i,
                box=tuple(float(v) for v in blk.xyxy),
                vertical=bool(blk.vertical),
                font_size=float(blk.font_size),
                lines=[[tuple(map(float, p)) for p in line.tolist()] for line in blk.lines_array()],
            )
            for i, blk in enumerate(blks)
        ]
        return reading_order(merge_duplicates(bubbles), page_width=img.shape[1])

    def ocr(self, img: np.ndarray, bubble: Bubble) -> str:
        h, w = img.shape[:2]
        x1, y1, x2, y2 = bubble.box
        crop = img[
            max(0, int(y1) - OCR_PAD) : min(h, int(y2) + OCR_PAD),
            max(0, int(x1) - OCR_PAD) : min(w, int(x2) + OCR_PAD),
        ]
        with self._lock:
            return self._mocr(Image.fromarray(crop))

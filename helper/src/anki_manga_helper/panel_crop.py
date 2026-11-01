"""Find the comic panel around a bubble and encode a small JPEG of it."""

from __future__ import annotations

import cv2
import numpy as np

MIN_PANEL_FRACTION = 0.03
GUTTER_LIGHTNESS = 180
FALLBACK_GROW = 0.75


def _fallback(img: np.ndarray, bubble_box) -> tuple[int, int, int, int]:
    h, w = img.shape[:2]
    x1, y1, x2, y2 = bubble_box
    grow = FALLBACK_GROW * max(x2 - x1, y2 - y1)
    return (
        int(max(0, x1 - grow)),
        int(max(0, y1 - grow)),
        int(min(w, x2 + grow)),
        int(min(h, y2 + grow)),
    )


def find_panel_box(img: np.ndarray, bubble_box) -> tuple[int, int, int, int]:
    """Gutter-based panel finding: light pixels connected to the page edge are
    gutter; every other large connected region is a panel (bubbles that cross a
    gutter just merge neighbouring panels). Returns the smallest panel holding the
    bubble's centre, else the bubble box grown by 0.75x."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    _, labels = cv2.connectedComponents((gray > GUTTER_LIGHTNESS).astype(np.uint8))
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    gutter = np.isin(labels, edge[edge != 0])
    panels = cv2.morphologyEx((~gutter).astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, comp, stats, _ = cv2.connectedComponentsWithStats(panels)
    cx = int((bubble_box[0] + bubble_box[2]) / 2)
    cy = int((bubble_box[1] + bubble_box[3]) / 2)
    best = None
    for i in range(1, n):
        x, y, bw, bh, _ = stats[i]
        if bw * bh < MIN_PANEL_FRACTION * w * h:
            continue
        if not (x <= cx < x + bw and y <= cy < y + bh):
            continue
        if best is None or bw * bh < best[2] * best[3]:
            best = (int(x), int(y), int(bw), int(bh))
    if best is None:
        return _fallback(img, bubble_box)
    x, y, bw, bh = best
    return (x, y, x + bw, y + bh)


def crop_jpeg(img: np.ndarray, box, max_side: int = 600, quality: int = 80) -> bytes:
    x1, y1, x2, y2 = (int(v) for v in box)
    crop = img[y1:y2, x1:x2]
    ch, cw = crop.shape[:2]
    scale = max_side / max(ch, cw)
    crop = cv2.resize(crop, (max(1, round(cw * scale)), max(1, round(ch * scale))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(crop, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("JPEG encode failed")
    return buf.tobytes()

"""Detected text bubbles: dedupe and manga reading order."""

from __future__ import annotations

from dataclasses import dataclass, field, replace

Box = tuple[float, float, float, float]


@dataclass
class Bubble:
    id: int
    box: Box  # x1, y1, x2, y2 in image pixels
    vertical: bool
    font_size: float
    lines: list[list[tuple[float, float]]] = field(default_factory=list)  # 4-point quads

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "box": [float(v) for v in self.box],
            "vertical": bool(self.vertical),
            "font_size": float(self.font_size),
            "lines": [[[float(x), float(y)] for x, y in quad] for quad in self.lines],
        }

    @classmethod
    def from_json(cls, d: dict) -> "Bubble":
        return cls(
            id=int(d["id"]),
            box=tuple(float(v) for v in d["box"]),
            vertical=bool(d["vertical"]),
            font_size=float(d["font_size"]),
            lines=[[tuple(p) for p in quad] for quad in d.get("lines", [])],
        )


def _area(b: Box) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _intersection(a: Box, b: Box) -> float:
    return _area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def _is_duplicate(a: Box, b: Box, iou: float) -> bool:
    inter = _intersection(a, b)
    if inter <= 0:
        return False
    union = _area(a) + _area(b) - inter
    if union > 0 and inter / union >= iou:
        return True
    smaller = min(_area(a), _area(b))
    return smaller > 0 and inter / smaller >= 0.9


def merge_duplicates(bubbles: list[Bubble], iou: float = 0.6) -> list[Bubble]:
    """Drop boxes that duplicate (IoU >= iou) or sit >= 90% inside a larger one."""
    kept: list[Bubble] = []
    for cand in sorted(bubbles, key=lambda x: _area(x.box), reverse=True):
        if not any(_is_duplicate(cand.box, k.box, iou) for k in kept):
            kept.append(cand)
    return kept


def reading_order(bubbles: list[Bubble], page_width: int) -> list[Bubble]:
    """Rows top->bottom (a bubble joins a row if its centre-y lies in the row's
    y-span), right->left inside a row; ids are reassigned 0..n-1."""
    rows: list[tuple[float, float, list[Bubble]]] = []
    for bub in sorted(bubbles, key=lambda x: x.box[1]):
        cy = (bub.box[1] + bub.box[3]) / 2
        for i, (top, bottom, members) in enumerate(rows):
            if top <= cy <= bottom:
                members.append(bub)
                rows[i] = (min(top, bub.box[1]), max(bottom, bub.box[3]), members)
                break
        else:
            rows.append((bub.box[1], bub.box[3], [bub]))
    rows.sort(key=lambda r: r[0])
    ordered = [m for _, _, members in rows for m in sorted(members, key=lambda x: -x.box[2])]
    return [replace(m, id=i) for i, m in enumerate(ordered)]

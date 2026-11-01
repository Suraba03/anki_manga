"""Regenerate extension/test/fixtures/dbnet-reference.json.

Runs the Python reference (SegDetectorRepresenter.boxes_from_bitmap with box_thresh applied) on synthetic
probability maps (filled rectangles and tilted quads), so extension/engine/dbnet.js can be checked against it.
No manga images are used.

    cd helper && uv run python -I ../tools/gen-dbnet-fixtures.py
"""
import json
from pathlib import Path

import cv2
import numpy as np
from comic_text_detector.utils.db_utils import SegDetectorRepresenter

OUT = Path(__file__).resolve().parent.parent / "extension" / "test" / "fixtures" / "dbnet-reference.json"
SIZE = 96


def make_map(seed):
    rng = np.random.default_rng(seed)
    prob = np.full((SIZE, SIZE), 0.1, np.float32)
    for _ in range(int(rng.integers(3, 7))):
        w, h = rng.integers(5, 16), rng.integers(15, 45) if rng.random() < 0.7 else rng.integers(5, 16)
        cx, cy = rng.uniform(25, SIZE - 25, 2)
        ang = np.deg2rad(rng.uniform(-12, 12) if rng.random() < 0.6 else 0)
        c, s = np.cos(ang), np.sin(ang)
        quad = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) @ np.array([[c, s], [-s, c]])
        quad = np.round(quad + [cx, cy]).astype(np.int32)
        mask = np.zeros((SIZE, SIZE), np.uint8)
        cv2.fillPoly(mask, [quad], 1)
        prob[mask > 0] = rng.integers(7, 10) / 10
    return prob


def main():
    rep = SegDetectorRepresenter(thresh=0.3)
    cases = []
    for seed in range(10):
        prob = make_map(seed)
        boxes, scores = rep((SIZE, SIZE), prob[None, None])
        keep = scores[0] > 0.6
        cases.append(
            {
                "prob": "".join(str(int(round(v * 10))) for v in prob.ravel()),  # one digit per pixel = prob * 10
                "boxes": boxes[0][keep].tolist(),
            }
        )
    OUT.write_text(json.dumps({"size": SIZE, "cases": cases}, separators=(",", ":")))
    print(f"{len(cases)} cases, {sum(len(c['boxes']) for c in cases)} boxes -> {OUT}")


if __name__ == "__main__":
    main()

"""Write v1-helper reference output for the model acceptance test (extension/test/models.test.mjs).

For every *.jpg in the samples folder, writes <folder>/reference/<name>.json with
  bubbles: the helper Engine's final bubbles (Bubble.to_json + OCR text),
  nms:     the raw postprocess_yolo blocks (xyxy int32 image coords, cls, conf),
  lines:   the DBNet quads handed to group_output (after box_thresh 0.6, image coords, int32).

    cd helper && uv run python -I ../tools/make-reference.py $ANKI_MANGA_SAMPLES

The reference lives in the samples folder (gitignored); manga pages never enter the repo.
"""
import json
import sys
from pathlib import Path

import comic_text_detector.inference as inf
from anki_manga_helper.boxes import Bubble
from anki_manga_helper.engine import Engine, decode_image


def main(folder: Path) -> None:
    captured: dict = {}
    orig_yolo, orig_group = inf.postprocess_yolo, inf.group_output

    def yolo(det, conf_thresh, nms_thresh, resize_ratio, sort_func=None):
        blines, cls, confs = orig_yolo(det, conf_thresh, nms_thresh, resize_ratio, sort_func)
        captured["nms"] = [
            {"box": [int(v) for v in b], "cls": int(c), "conf": float(s)} for b, c, s in zip(blines, cls, confs)
        ]
        return blines, cls, confs

    def group(blks, lines, im_w, im_h, mask=None, sort_blklist=True):
        captured["lines"] = [[[int(x), int(y)] for x, y in quad] for quad in lines]
        return orig_group(blks, lines, im_w, im_h, mask, sort_blklist)

    inf.postprocess_yolo, inf.group_output = yolo, group

    engine = Engine()
    engine.load()
    out_dir = folder / "reference"
    out_dir.mkdir(exist_ok=True)
    for path in sorted(folder.glob("*.jpg")):
        img = decode_image(path.read_bytes())
        bubbles = engine.detect(img)
        rows = []
        for b in bubbles:
            row = b.to_json()
            row["text"] = engine.ocr(img, Bubble.from_json(row))
            rows.append(row)
        doc = {
            "width": int(img.shape[1]),
            "height": int(img.shape[0]),
            "bubbles": rows,
            "nms": captured["nms"],
            "lines": captured["lines"],
        }
        (out_dir / f"{path.stem}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf8")
        print(f"{path.name}: {len(rows)} bubbles, {len(doc['nms'])} nms blocks, {len(doc['lines'])} lines")


if __name__ == "__main__":
    main(Path(sys.argv[1]).expanduser().resolve())

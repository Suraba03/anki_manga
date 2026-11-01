"""Write v1-helper reference output for the model acceptance test (extension/test/models.test.mjs).

For every *.jpg in the samples folder, writes <folder>/reference/<name>.json with
  bubbles: the helper Engine's final bubbles (Bubble.to_json + OCR text = the helper's beam search, and
           text_greedy = the same PyTorch model decoded greedily, which is what the browser does),
  nms:     the raw postprocess_yolo blocks (xyxy int32 image coords, cls, conf),
  lines:   the DBNet quads handed to group_output (after box_thresh 0.6, image coords, int32).

    cd helper && uv run python -I ../tools/make-reference.py $ANKI_MANGA_SAMPLES

The reference lives in the samples folder (gitignored); manga pages never enter the repo.
"""
import json
import sys
from pathlib import Path

import comic_text_detector.inference as inf
import torch
from PIL import Image
from manga_ocr.ocr import post_process
from anki_manga_helper.boxes import Bubble
from anki_manga_helper.engine import Engine, decode_image


def ocr_greedy(engine: Engine, img, bubble: Bubble) -> str:
    """Engine.ocr with the same crop and post_process, but num_beams=1 and no n-gram blocking (HF default beams: 4, 3)."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = bubble.box
    pad = 4  # engine.OCR_PAD
    crop = img[max(0, int(y1) - pad) : min(h, int(y2) + pad), max(0, int(x1) - pad) : min(w, int(x2) + pad)]
    mocr = engine._mocr
    x = mocr.processor(Image.fromarray(crop).convert("L").convert("RGB"), return_tensors="pt").pixel_values.squeeze()
    with torch.inference_mode():
        out = mocr.model.generate(
            x[None].to(mocr.model.device), max_length=300, num_beams=1, no_repeat_ngram_size=0, do_sample=False
        )[0].cpu()
    return post_process(mocr.tokenizer.decode(out, skip_special_tokens=True))


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
            bubble = Bubble.from_json(row)
            row["text"] = engine.ocr(img, bubble)
            row["text_greedy"] = ocr_greedy(engine, img, bubble)
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

"""Regenerate extension/test/fixtures/preprocess-reference.json.

Runs the Python reference (comic_text_detector letterbox, manga_ocr crop + ViTImageProcessor,
manga_ocr post_process) on synthetic images, so the JS ports in extension/engine/{image,ocr}.js
can be checked against it. No manga images are used.

    cd helper && uv run python -I ../tools/gen-preprocess-fixtures.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "test" / "fixtures" / "preprocess-reference.json"
PREPROCESSOR_DIR = ROOT / "tools" / ".cache" / "models"  # holds preprocessor_config.json
OCR_PAD = 4  # helper/src/anki_manga_helper/engine.py


def synth(w, h):
    """RGB uint8 image; the formula is mirrored in extension/test/image.test.mjs."""
    y, x = np.mgrid[0:h, 0:w]
    chans = [(x * 31 + y * 17 + c * 53 + ((x * y) % 97) * 3 + (((x >> 3) ^ (y >> 2)) & 15) * 5) & 255 for c in range(3)]
    return np.stack(chans, axis=-1).astype(np.uint8)


def sample(flat, n_extra=()):
    n = flat.size
    idx = sorted(set(list(range(7, n, 4999 if n > 500000 else 211)) + list(n_extra)))
    return {"idx": idx, "val": [round(float(flat[i]), 6) for i in idx]}


def det_case(w, h, size=1024):
    from comic_text_detector.inference import preprocess_img

    img = synth(w, h)
    tensor, ratio, dw, dh = preprocess_img(img, input_size=(size, size), device="cpu", bgr2rgb=True, to_tensor=True)
    t = tensor.numpy()[0]
    new_w, new_h = size - dw, size - dh
    edge = [c * size * size + y * size + x for c in range(3) for y in (new_h - 1, min(new_h, size - 1)) for x in (0, new_w - 1, min(new_w, size - 1))]
    return {
        "w": w, "h": h, "size": size, "scale": ratio[0], "padW": dw, "padH": dh,
        "ref": sample(t.reshape(-1), edge),
    }


def ocr_case(w, h, box):
    from transformers import ViTImageProcessor

    img = synth(w, h)
    x1, y1, x2, y2 = box
    crop = img[max(0, int(y1) - OCR_PAD): min(h, int(y2) + OCR_PAD), max(0, int(x1) - OCR_PAD): min(w, int(x2) + OCR_PAD)]
    pil = Image.fromarray(crop).convert("L").convert("RGB")
    proc = ViTImageProcessor.from_pretrained(str(PREPROCESSOR_DIR))
    px = proc(pil, return_tensors="pt").pixel_values.squeeze().numpy()
    return {"w": w, "h": h, "box": list(box), "ref": sample(px.reshape(-1))}


def post_cases():
    from manga_ocr.ocr import post_process

    inputs = [
        "ん?", "でも今回の…", "手紙......?", "あ !", "ｶﾞﾝﾊﾞﾚ", "ｳﾞｧｲｵﾘﾝ ﾊﾟﾝ ﾎﾟﾝ", "a b\tc\n1 2 3",
        "ABC xyz 0123456789", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", "・・・", "あ・い", "あ..い", "あ.い", "え・・・・お",
        "…なに…?", "ｦﾝｰ･｢｣｡､ｧｨｩｪｫｬｭｮｯ", "ﾜﾞｦﾞ ﾞﾟ", "ｱﾞ", "漢字　全角　空白", "ｶﾞ ﾞ", "あ ....... い", "ー−―",
    ]
    return [{"in": s, "out": post_process(s)} for s in inputs]


def main():
    data = {
        "det": [det_case(1500, 900), det_case(300, 200), det_case(777, 1301), det_case(640, 640, 256)],
        "ocr": [
            ocr_case(600, 400, (100, 50, 300, 350)),
            ocr_case(100, 80, (20.7, 20.2, 60.9, 50.6)),
            ocr_case(50, 40, (-5, -3, 20, 30)),
            ocr_case(300, 500, (250.5, 400.5, 330, 520)),
        ],
        "post": post_cases(),
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("wrote", OUT, OUT.stat().st_size, "bytes")


main()

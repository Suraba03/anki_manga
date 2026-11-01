import os
from pathlib import Path

import pytest

from anki_manga_helper.engine import Engine, decode_image

SAMPLES = os.environ.get("ANKI_MANGA_SAMPLES")
needs_samples = pytest.mark.skipif(not SAMPLES, reason="set ANKI_MANGA_SAMPLES to run model tests")


@pytest.fixture(scope="module")
def engine():
    e = Engine()
    e.load()
    return e


def _page(name):
    return decode_image((Path(SAMPLES) / name).read_bytes())


@pytest.mark.models
@needs_samples
def test_detect_and_ocr_sample_a(engine):
    img = _page("1e09e93d853dac2e659ec5f4b70b46bb009.jpg")
    bubbles = engine.detect(img)
    assert len(bubbles) == 11
    texts = [engine.ocr(img, b) for b in bubbles]
    assert "これは坂の角度が正確に分かる道具なのです！" in "".join(texts)
    assert texts[0] == "昨日は"


@pytest.mark.models
@needs_samples
def test_no_duplicate_majika(engine):
    img = _page("8e53654f98e2a48be4e65659e5f79b68010.jpg")
    texts = [engine.ocr(img, b) for b in engine.detect(img)]
    assert texts.count("まじか！") == 1


def test_decode_rejects_garbage():
    with pytest.raises(ValueError):
        decode_image(b"nope")


def test_engine_not_ready_before_load():
    assert Engine().ready is False

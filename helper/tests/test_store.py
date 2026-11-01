import os
import time

import pytest

from anki_manga_helper import store as store_mod
from anki_manga_helper.store import Store


@pytest.fixture
def st(tmp_path):
    return Store(tmp_path / "db.sqlite3")


def _bubbles(n):
    return [{"id": i, "box": [0, 0, 1, 1], "vertical": True, "font_size": 1.0, "lines": []} for i in range(n)]


def test_page_roundtrip_with_texts(st):
    st.save_page("p", 100, 200, _bubbles(2))
    st.set_text("p", 1, "あ")
    page = st.get_page("p")
    assert (page["width"], page["height"]) == (100, 200)
    assert [b["text"] for b in page["bubbles"]] == [None, "あ"]
    assert st.get_text("p", 1) == "あ"
    assert st.get_page("missing") is None


def test_same_bytes_same_id(st):
    assert st.page_id_for(b"x") == st.page_id_for(b"x") != st.page_id_for(b"y")


def test_image_pruning(st, monkeypatch):
    monkeypatch.setattr(store_mod, "MAX_PAGE_IMAGES", 3)
    for i in range(5):
        st.save_image(f"p{i}", b"img%d" % i)
        path = st._image_path(f"p{i}")
        os.utime(path, (time.time() - 100 + i, time.time() - 100 + i))
    st.save_image("p4", b"img4")
    assert st.load_image("p0") is None
    assert st.load_image("p1") is None
    assert st.load_image("p4") == b"img4"
    assert len(list(st._images_dir.iterdir())) == 3


def test_explanation_key_normalizes(st):
    assert st.explanation_key(" あ！ ") == st.explanation_key("あ!")


def test_explanation_roundtrip(st):
    st.save_explanation("k", {"translation": "x"})
    assert st.get_explanation("k") == {"translation": "x"}
    assert st.get_explanation("nope") is None

import asyncio
import threading
import time

import pytest

from anki_manga_helper.scheduler import OcrScheduler
from anki_manga_helper.store import Store

from .fakes import IMG, FakeEngine, make_bubbles


@pytest.fixture
def st(tmp_path):
    return Store(tmp_path / "db.sqlite3")


def _wait_all(st, pid, n, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(st.get_text(pid, i) is not None for i in range(n)):
            return
        time.sleep(0.01)
    raise AssertionError("OCR did not finish")


def _save(st, pid, bubbles):
    st.save_page(pid, 10, 10, [b.to_json() for b in bubbles])


def test_processes_in_reading_order(st):
    eng = FakeEngine()
    sch = OcrScheduler(eng, st)
    sch.start()
    bubbles = make_bubbles(3)
    _save(st, "p", bubbles)
    sch.enqueue_page("p", IMG, bubbles)
    _wait_all(st, "p", 3)
    assert eng.calls == [0, 1, 2]
    assert [st.get_text("p", i) for i in range(3)] == ["t0", "t1", "t2"]


def test_prioritize_jumps_queue(st):
    eng = FakeEngine(block_first=True)
    sch = OcrScheduler(eng, st)
    sch.start()
    bubbles = make_bubbles(5)
    _save(st, "p", bubbles)
    sch.enqueue_page("p", IMG, bubbles)
    assert eng.started.wait(5)
    sch.prioritize("p", 4)
    eng.release.set()
    _wait_all(st, "p", 5)
    assert eng.calls[:2] == [0, 4]
    assert sorted(eng.calls) == [0, 1, 2, 3, 4]


def test_cached_bubbles_not_reprocessed(st):
    eng = FakeEngine()
    sch = OcrScheduler(eng, st)
    sch.start()
    bubbles = make_bubbles(3)
    _save(st, "p", bubbles)
    sch.enqueue_page("p", IMG, bubbles)
    _wait_all(st, "p", 3)
    sch.enqueue_page("p", IMG, bubbles)
    time.sleep(0.1)
    assert eng.calls == [0, 1, 2]


def test_subscribe_yields_all_then_ends(st):
    eng = FakeEngine()
    sch = OcrScheduler(eng, st)
    sch.start()
    bubbles = make_bubbles(3)
    _save(st, "p", bubbles)

    async def collect():
        sch.enqueue_page("p", IMG, bubbles)
        got = {}
        async for bid, text in sch.subscribe("p"):
            got[bid] = text
        return got

    assert asyncio.run(asyncio.wait_for(collect(), 5)) == {0: "t0", 1: "t1", 2: "t2"}


def test_wait_text_unknown_returns_none(st):
    sch = OcrScheduler(FakeEngine(), st)
    sch.start()
    assert sch.wait_text("nope", 0, timeout=0.2) is None


def test_wait_text_prioritizes(st):
    eng = FakeEngine(block_first=True)
    sch = OcrScheduler(eng, st)
    sch.start()
    bubbles = make_bubbles(4)
    _save(st, "p", bubbles)
    sch.enqueue_page("p", IMG, bubbles)
    assert eng.started.wait(5)
    result = {}
    waiter = threading.Thread(target=lambda: result.setdefault("t", sch.wait_text("p", 3, timeout=5)))
    waiter.start()
    time.sleep(0.05)  # let wait_text register its priority before the worker moves on
    eng.release.set()
    waiter.join(5)
    assert result["t"] == "t3"
    assert eng.calls[:2] == [0, 3]


def test_subscribe_after_done_replays_all(st):
    # The extension opens the stream only when a page is displayed, possibly long after OCR finished.
    eng = FakeEngine()
    sch = OcrScheduler(eng, st)
    sch.start()
    bubbles = make_bubbles(3)
    _save(st, "p", bubbles)
    sch.enqueue_page("p", IMG, bubbles)
    _wait_all(st, "p", 3)

    async def collect():
        return {bid: t async for bid, t in sch.subscribe("p")}

    assert asyncio.run(asyncio.wait_for(collect(), 2)) == {0: "t0", 1: "t1", 2: "t2"}

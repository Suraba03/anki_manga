"""Single-worker OCR queue: bubbles in reading order, hovered/clicked ones first."""

from __future__ import annotations

import asyncio
import heapq
import itertools
import threading
from collections.abc import AsyncIterator

import numpy as np

from .boxes import Bubble

NORMAL = 10
URGENT = 0


class OcrScheduler:
    def __init__(self, engine, store) -> None:
        self._engine = engine
        self._store = store
        self._cond = threading.Condition()
        self._heap: list[tuple[int, int, str, int]] = []
        self._seq = itertools.count()
        self._pending: dict[tuple[str, int], int] = {}  # (page, bubble) -> current priority
        self._pages: dict[str, tuple[np.ndarray, dict[int, Bubble]]] = {}
        self._subs: dict[str, list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = {}
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="ocr-worker", daemon=True)
            self._thread.start()

    # producer side ---------------------------------------------------------
    def enqueue_page(self, page_id: str, img: np.ndarray, bubbles: list[Bubble]) -> None:
        with self._cond:
            todo = [b for b in sorted(bubbles, key=lambda b: b.id) if self._store.get_text(page_id, b.id) is None]
            if not todo:
                return
            self._pages[page_id] = (img, {b.id: b for b in bubbles})
            for b in todo:
                key = (page_id, b.id)
                if key not in self._pending:
                    self._push(page_id, b.id, NORMAL)
            self._cond.notify_all()

    def prioritize(self, page_id: str, bubble_id: int) -> None:
        with self._cond:
            key = (page_id, bubble_id)
            if key in self._pending and self._pending[key] > URGENT:
                self._push(page_id, bubble_id, URGENT)
                self._cond.notify_all()

    def wait_text(self, page_id: str, bubble_id: int, timeout: float) -> str | None:
        self.prioritize(page_id, bubble_id)
        with self._cond:
            self._cond.wait_for(lambda: self._store.get_text(page_id, bubble_id) is not None, timeout)
        return self._store.get_text(page_id, bubble_id)

    async def subscribe(self, page_id: str) -> AsyncIterator[tuple[int, str]]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        entry = (loop, queue)
        with self._cond:
            self._subs.setdefault(page_id, []).append(entry)
        try:
            page = self._store.get_page(page_id)
            if page is None:
                return
            remaining = {b["id"] for b in page["bubbles"]}
            for b in page["bubbles"]:
                if b["text"] is not None and b["id"] in remaining:
                    remaining.discard(b["id"])
                    yield b["id"], b["text"]
            while remaining:
                bid, text = await queue.get()
                if bid in remaining:
                    remaining.discard(bid)
                    yield bid, text
        finally:
            with self._cond:
                subs = self._subs.get(page_id, [])
                if entry in subs:
                    subs.remove(entry)
                if not subs:
                    self._subs.pop(page_id, None)

    # worker side -------------------------------------------------------------
    def _push(self, page_id: str, bubble_id: int, priority: int) -> None:
        self._pending[(page_id, bubble_id)] = priority
        heapq.heappush(self._heap, (priority, next(self._seq), page_id, bubble_id))

    def _next_job(self) -> tuple[str, int, np.ndarray, Bubble]:
        with self._cond:
            while True:
                while self._heap:
                    priority, _, pid, bid = heapq.heappop(self._heap)
                    if self._pending.get((pid, bid)) != priority:
                        continue  # stale entry superseded by prioritize()
                    img, bubbles = self._pages[pid]
                    return pid, bid, img, bubbles[bid]
                self._cond.wait()

    def _run(self) -> None:
        while True:
            pid, bid, img, bubble = self._next_job()
            try:
                text = self._engine.ocr(img, bubble)
            except Exception:  # keep the worker alive; an empty text marks the bubble done
                text = ""
            self._store.set_text(pid, bid, text)
            with self._cond:
                self._pending.pop((pid, bid), None)
                if not any(k[0] == pid for k in self._pending):
                    self._pages.pop(pid, None)
                subs = list(self._subs.get(pid, []))
                self._cond.notify_all()
            for loop, queue in subs:
                loop.call_soon_threadsafe(queue.put_nowait, (bid, text))

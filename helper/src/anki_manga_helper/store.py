"""SQLite cache for pages, OCR texts and explanations, plus page image files."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import unicodedata
from pathlib import Path

from .deepseek import PROMPT_VERSION

MAX_PAGE_IMAGES = 300

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, width INT, height INT, bubbles TEXT);
CREATE TABLE IF NOT EXISTS texts (page_id TEXT, bubble_id INT, text TEXT, PRIMARY KEY (page_id, bubble_id));
CREATE TABLE IF NOT EXISTS explanations (key TEXT PRIMARY KEY, data TEXT);
"""


class Store:
    def __init__(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._images_dir = path.parent / "pages"
        self._images_dir.mkdir(exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(_SCHEMA)

    # pages ---------------------------------------------------------------
    @staticmethod
    def page_id_for(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def save_page(self, page_id: str, width: int, height: int, bubbles: list[dict]) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO pages VALUES (?,?,?,?)",
                (page_id, width, height, json.dumps(bubbles)),
            )

    def get_page(self, page_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT width, height, bubbles FROM pages WHERE id=?", (page_id,)).fetchone()
            if row is None:
                return None
            texts = dict(self._db.execute("SELECT bubble_id, text FROM texts WHERE page_id=?", (page_id,)).fetchall())
        bubbles = [{**b, "text": texts.get(b["id"])} for b in json.loads(row[2])]
        return {"width": row[0], "height": row[1], "bubbles": bubbles}

    def set_text(self, page_id: str, bubble_id: int, text: str) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO texts VALUES (?,?,?)", (page_id, bubble_id, text))

    def get_text(self, page_id: str, bubble_id: int) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT text FROM texts WHERE page_id=? AND bubble_id=?", (page_id, bubble_id)
            ).fetchone()
        return row[0] if row else None

    # page images -----------------------------------------------------------
    def _image_path(self, page_id: str) -> Path:
        return self._images_dir / f"{page_id}.img"

    def save_image(self, page_id: str, data: bytes) -> None:
        self._image_path(page_id).write_bytes(data)
        files = sorted(self._images_dir.iterdir(), key=lambda p: p.stat().st_mtime)
        for old in files[: max(0, len(files) - MAX_PAGE_IMAGES)]:
            old.unlink(missing_ok=True)

    def load_image(self, page_id: str) -> bytes | None:
        path = self._image_path(page_id)
        return path.read_bytes() if path.exists() else None

    # explanations ----------------------------------------------------------
    @staticmethod
    def explanation_key(text: str) -> str:
        norm = unicodedata.normalize("NFKC", text).strip()
        return hashlib.sha256(f"{PROMPT_VERSION}\n{norm}".encode()).hexdigest()

    def get_explanation(self, key: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT data FROM explanations WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_explanation(self, key: str, data: dict) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO explanations VALUES (?,?)", (key, json.dumps(data, ensure_ascii=False)))

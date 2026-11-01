"""HTTP API for the extension (127.0.0.1 only, extension origins only, token-gated)."""

from __future__ import annotations

import html
import json
import threading
from collections.abc import Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import __version__
from .anki import AnkiError, AnkiUnreachable
from .boxes import Bubble
from .config import Config, save_config
from .deepseek import ExplainError
from .engine import decode_image
from .known import KnownWords
from .panel_crop import crop_jpeg, find_panel_box
from .text import bold_word, ruby_html

OPEN_PATHS = {("GET", "/health"), ("POST", "/pair")}
RESET_HINT = "Run: anki-manga-helper --reset-pairing"
EXPLAIN_STATUS = {"no_api_key": 400, "auth": 401}


class SettingsBody(BaseModel):
    api_key: str


class DeckBody(BaseModel):
    deck: str


class ExplainBody(BaseModel):
    page_id: str
    bubble_id: int
    deck: str


class CardBody(BaseModel):
    page_id: str
    bubble_id: int
    deck: str
    word: str
    reading: str
    meaning: str
    source_url: str
    source_title: str


def _err(status: int, error: str, **extra) -> JSONResponse:
    return JSONResponse({"error": error, **extra}, status_code=status)


def create_app(config: Config, engine, store, scheduler, anki, deepseek_factory: Callable) -> FastAPI:
    app = FastAPI(title="anki_manga helper", version=__version__)
    allowed_hosts = {f"127.0.0.1:{config.port}", f"localhost:{config.port}"}
    known: dict[str, KnownWords] = {}
    state = {"note_type_ready": False}
    lock = threading.Lock()

    def cors(resp: Response, origin: str) -> Response:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        return resp

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.headers.get("host") not in allowed_hosts:
            return _err(403, "bad_host")
        # Web pages always send Origin on requests that could do harm; Chrome may omit it
        # on extension GETs made with host permission, so absent is allowed (token still gates).
        origin = request.headers.get("origin")
        if origin is not None and not origin.startswith("chrome-extension://"):
            return _err(403, "bad_origin")
        origin = origin or "null"
        if request.method == "OPTIONS":
            resp = Response(status_code=204)
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-AM-Token"
            resp.headers["Access-Control-Max-Age"] = "600"
            return cors(resp, origin)
        if (request.method, request.url.path) not in OPEN_PATHS and request.headers.get("x-am-token") != config.token:
            return cors(_err(401, "bad_token"), origin)
        return cors(await call_next(request), origin)

    # --- setup ------------------------------------------------------------------
    @app.get("/health")
    def health():
        return {
            "status": "ready" if engine.ready else "warming",
            "version": __version__,
            "paired": config.paired,
            "has_api_key": bool(config.api_key),
        }

    @app.post("/pair")
    def pair():
        with lock:
            if config.paired:
                return _err(409, "already_paired", hint=RESET_HINT)
            config.paired = True
            save_config(config)
        return {"token": config.token}

    @app.get("/auth/check", status_code=204)
    def auth_check():
        return Response(status_code=204)

    @app.put("/settings")
    def settings(body: SettingsBody):
        config.api_key = body.api_key.strip() or None
        save_config(config)
        return {"has_api_key": bool(config.api_key)}

    # --- pages ------------------------------------------------------------------
    @app.post("/pages")
    async def post_page(request: Request, url: str = ""):
        if not engine.ready:
            return _err(503, "warming")
        data = await request.body()
        return await _run_sync(lambda: _process_page(data))

    def _process_page(data: bytes):
        try:
            img = decode_image(data)
        except ValueError:
            return _err(400, "bad_image")
        pid = store.page_id_for(data)
        page = store.get_page(pid)
        if page is None:
            bubbles = engine.detect(img)
            store.save_page(pid, img.shape[1], img.shape[0], [b.to_json() for b in bubbles])
            page = store.get_page(pid)
        else:
            bubbles = [Bubble.from_json(b) for b in page["bubbles"]]
        if store.load_image(pid) is None:
            store.save_image(pid, data)
        scheduler.enqueue_page(pid, img, bubbles)
        return {"page_id": pid, "width": page["width"], "height": page["height"], "bubbles": page["bubbles"]}

    @app.get("/pages/{pid}/events")
    async def events(pid: str):
        async def stream():
            async for bid, text in scheduler.subscribe(pid):
                yield f"data: {json.dumps({'bubble_id': bid, 'text': text}, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.post("/pages/{pid}/bubbles/{bid}/prioritize", status_code=204)
    def prioritize(pid: str, bid: int):
        scheduler.prioritize(pid, bid)
        return Response(status_code=204)

    @app.get("/pages/{pid}/bubbles/{bid}")
    def bubble(pid: str, bid: int):
        if store.get_page(pid) is None:
            return _err(404, "unknown_page")
        text = scheduler.wait_text(pid, bid, timeout=10)
        if text is None:
            return _err(504, "ocr_timeout")
        return {"text": text, "ruby_html": ruby_html(text)}

    # --- anki -------------------------------------------------------------------
    def _ensure_note_type():
        if not state["note_type_ready"]:
            anki.ensure_note_type()
            state["note_type_ready"] = True

    @app.get("/anki/decks")
    def decks():
        try:
            _ensure_note_type()
            return {"decks": anki.deck_names()}
        except AnkiUnreachable:
            return _err(503, "anki_unreachable")

    @app.post("/anki/refresh", status_code=204)
    def refresh(body: DeckBody):
        try:
            known[body.deck] = anki.known_words(body.deck)
        except AnkiUnreachable:
            return _err(503, "anki_unreachable")
        return Response(status_code=204)

    def _known(deck: str) -> KnownWords | None:
        if deck not in known:
            try:
                known[deck] = anki.known_words(deck)
            except (AnkiUnreachable, AnkiError):
                return None
        return known[deck]

    # --- explain / cards ------------------------------------------------------------
    @app.post("/explain")
    def explain(body: ExplainBody):
        text = store.get_text(body.page_id, body.bubble_id)
        if text is None:
            return _err(404, "unknown_bubble")
        key = store.explanation_key(text)
        data = store.get_explanation(key)
        cached = data is not None
        if not cached:
            try:
                data = deepseek_factory(config).explain(text)
            except ExplainError as e:
                return _err(EXPLAIN_STATUS.get(e.kind, 502), e.kind)
            store.save_explanation(key, data)
        kw = _known(body.deck)
        suggestions = [
            {**s, "in_deck": None if kw is None else kw.is_known(s["word"], s["reading"])} for s in data["suggestions"]
        ]
        return {
            "text": text,
            "translation": data["translation"],
            "notes": data["notes"],
            "suggestions": suggestions,
            "cached": cached,
            "anki": "unreachable" if kw is None else "ok",
        }

    @app.post("/cards")
    def cards(body: CardBody):
        page = store.get_page(body.page_id)
        text = store.get_text(body.page_id, body.bubble_id)
        if page is None or text is None:
            return _err(404, "unknown_bubble")
        image = store.load_image(body.page_id)
        if image is None:
            return _err(410, "page_expired")
        bub = next(b for b in page["bubbles"] if b["id"] == body.bubble_id)
        img = decode_image(image)
        picture = crop_jpeg(img, find_panel_box(img, bub["box"]))
        expl = store.get_explanation(store.explanation_key(text)) or {}
        fields = {
            "Word": body.word,
            "Reading": body.reading,
            "Meaning": body.meaning,
            "Sentence": bold_word(text, body.word),
            "SentenceFurigana": ruby_html(text),
            "SentenceTranslation": expl.get("translation", ""),
            "Explanation": "".join(
                f"<b>{html.escape(n['focus'])}</b> — {html.escape(n['explanation'])}<br>" for n in expl.get("notes", [])
            ),
            "Source": f'<a href="{html.escape(body.source_url, quote=True)}">{html.escape(body.source_title)}</a>',
        }
        try:
            _ensure_note_type()
            note_id = anki.add_card(body.deck, fields, picture, f"anki_manga_{body.page_id[:12]}_{body.bubble_id}.jpg")
        except AnkiUnreachable:
            return _err(503, "anki_unreachable")
        except AnkiError as e:
            return _err(409, "duplicate") if str(e) == "duplicate" else _err(502, "anki_error", detail=str(e))
        kw = _known(body.deck)
        if kw is not None:
            kw.add(body.word)
        return {"note_id": note_id}

    return app


async def _run_sync(fn):
    from starlette.concurrency import run_in_threadpool

    return await run_in_threadpool(fn)

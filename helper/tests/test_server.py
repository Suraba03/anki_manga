import pytest
from fastapi.testclient import TestClient

from anki_manga_helper import config as cfg
from anki_manga_helper.deepseek import ExplainError
from anki_manga_helper.scheduler import OcrScheduler
from anki_manga_helper.server import create_app
from anki_manga_helper.store import Store

from .fakes import FakeAnki, FakeDeepSeek, FakeEngine, png_bytes

ORIGIN = "chrome-extension://abc"


class Env:
    def __init__(self, tmp_path, anki=None):
        self.config = cfg.load_config()
        self.engine = FakeEngine(n_bubbles=2)
        self.store = Store(tmp_path / "db.sqlite3")
        self.scheduler = OcrScheduler(self.engine, self.store)
        self.scheduler.start()
        self.anki = anki or FakeAnki()
        self.deepseek = FakeDeepSeek()
        app = create_app(self.config, self.engine, self.store, self.scheduler, self.anki, lambda c: self.deepseek)
        self.client = TestClient(app, base_url="http://127.0.0.1:47812")
        self.client.headers.update({"Origin": ORIGIN, "X-AM-Token": self.config.token})

    def page(self, seed=0):
        r = self.client.post("/pages", params={"url": "https://cdn/x.jpg"}, content=png_bytes(seed),
                             headers={"Content-Type": "image/png"})
        assert r.status_code == 200, r.text
        return r.json()

    def text(self, pid, bid=0):
        r = self.client.get(f"/pages/{pid}/bubbles/{bid}")
        assert r.status_code == 200, r.text
        return r.json()


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


# --- security -----------------------------------------------------------------

def test_rejects_bad_origin(env):
    r = env.client.get("/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert r.json() == {"error": "bad_origin"}


def test_missing_origin_allowed_but_token_still_required(env):
    # Chrome may omit Origin on extension GETs with host permission; web pages always send one.
    env.client.headers.pop("Origin")
    assert env.client.get("/health").status_code == 200
    assert env.client.get("/anki/decks", headers={"X-AM-Token": "wrong"}).status_code == 401


def test_rejects_web_page_pair(env):
    r = env.client.post("/pair", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_rejects_bad_host(env):
    r = env.client.get("/health", headers={"Host": "evil.example:47812"})
    assert r.status_code == 403
    assert r.json() == {"error": "bad_host"}


def test_requires_token(env):
    r = env.client.get("/anki/decks", headers={"X-AM-Token": "wrong"})
    assert r.status_code == 401


def test_health_without_token(env):
    env.client.headers.pop("X-AM-Token")
    r = env.client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"
    assert r.json()["paired"] is False


def test_preflight_allowed(env):
    r = env.client.options("/explain", headers={"Access-Control-Request-Method": "POST",
                                                 "Access-Control-Request-Headers": "x-am-token,content-type"})
    assert r.status_code in (200, 204)
    assert r.headers["access-control-allow-origin"] == ORIGIN


def test_pair_once_then_409_with_hint(env):
    first = env.client.post("/pair")
    assert first.status_code == 200
    assert first.json()["token"] == env.config.token
    second = env.client.post("/pair")
    assert second.status_code == 409
    assert "anki-manga-helper --reset-pairing" in second.json()["hint"]
    assert cfg.load_config().paired is True


# --- pages ----------------------------------------------------------------------

def test_pages_warming(env):
    env.engine.ready = False
    r = env.client.post("/pages", content=png_bytes(), headers={"Content-Type": "image/png"})
    assert r.status_code == 503
    assert r.json() == {"error": "warming"}


def test_pages_bad_image(env):
    r = env.client.post("/pages", content=b"nope", headers={"Content-Type": "image/png"})
    assert r.status_code == 400


def test_pages_cached_no_redetect(env):
    a = env.page()
    b = env.page()
    assert env.engine.detect_calls == 1
    assert a["page_id"] == b["page_id"]
    assert len(a["bubbles"]) == 2
    assert {"id", "box", "vertical", "font_size", "lines", "text"} <= set(a["bubbles"][0])


def test_bubble_text_and_ruby(env):
    pid = env.page()["page_id"]
    assert env.text(pid, 1) == {"text": "t1", "ruby_html": "t1"}
    assert env.client.get("/pages/nope/bubbles/0").status_code == 404


def test_events_stream_all_then_done(env):
    pid = env.page()["page_id"]
    with env.client.stream("GET", f"/pages/{pid}/events") as r:
        body = "".join(r.iter_text())
    assert '"bubble_id": 0' in body and '"bubble_id": 1' in body
    assert "event: done" in body


def test_prioritize_204(env):
    pid = env.page()["page_id"]
    assert env.client.post(f"/pages/{pid}/bubbles/0/prioritize").status_code == 204


# --- settings / anki ----------------------------------------------------------------

def test_settings_saves_key(env):
    r = env.client.put("/settings", json={"api_key": "sk-new"})
    assert r.json() == {"has_api_key": True}
    assert cfg.load_config().api_key == "sk-new"


def test_decks_ensures_note_type_once(env):
    assert env.client.get("/anki/decks").json() == {"decks": ["manga mining"]}
    env.client.get("/anki/decks")
    assert env.anki.ensured == 1


def test_decks_anki_down(tmp_path):
    e = Env(tmp_path, anki=FakeAnki(down=True))
    r = e.client.get("/anki/decks")
    assert r.status_code == 503
    assert r.json() == {"error": "anki_unreachable"}


# --- explain ------------------------------------------------------------------------

def _explain(env, pid, bid=0):
    return env.client.post("/explain", json={"page_id": pid, "bubble_id": bid, "deck": "manga mining"})


def test_explain_cached_once(env):
    pid = env.page()["page_id"]
    env.text(pid)
    first = _explain(env, pid)
    second = _explain(env, pid)
    assert first.status_code == 200
    assert first.json()["cached"] is False
    assert second.json()["cached"] is True
    assert env.deepseek.calls == 1
    assert first.json()["text"] == "t0"
    assert first.json()["translation"] == "EN:t0"


def test_explain_failure_not_cached(env):
    pid = env.page()["page_id"]
    env.text(pid)
    env.deepseek.fail_with = ExplainError("bad_response")
    r = _explain(env, pid)
    assert r.status_code == 502
    assert r.json() == {"error": "bad_response"}
    assert _explain(env, pid).status_code == 200
    assert env.deepseek.calls == 2


@pytest.mark.parametrize("kind,status", [("no_api_key", 400), ("auth", 401), ("network", 502)])
def test_explain_error_statuses(env, kind, status):
    pid = env.page()["page_id"]
    env.text(pid)
    env.deepseek.fail_with = ExplainError(kind)
    r = _explain(env, pid)
    assert r.status_code == status
    assert r.json() == {"error": kind}


def test_explain_without_anki(tmp_path):
    e = Env(tmp_path, anki=FakeAnki(down=True))
    pid = e.page()["page_id"]
    e.text(pid)
    body = _explain(e, pid).json()
    assert body["anki"] == "unreachable"
    assert all(s["in_deck"] is None for s in body["suggestions"])


def test_explain_marks_in_deck(tmp_path):
    e = Env(tmp_path, anki=FakeAnki(known=["道具"]))
    pid = e.page()["page_id"]
    e.text(pid)
    body = _explain(e, pid).json()
    assert body["anki"] == "ok"
    flags = {s["word"]: s["in_deck"] for s in body["suggestions"]}
    assert flags == {"道具": True, "角度": False}


# --- cards --------------------------------------------------------------------------

def _card(env, pid, word="道具"):
    return env.client.post("/cards", json={
        "page_id": pid, "bubble_id": 0, "deck": "manga mining", "word": word, "reading": "どうぐ",
        "meaning": "tool", "source_url": "https://site/ch1", "source_title": "Chapter 1"})


def test_cards_fields_and_picture(env):
    pid = env.page()["page_id"]
    env.text(pid)
    _explain(env, pid)
    r = _card(env, pid, word="t0")
    assert r.status_code == 200, r.text
    assert r.json() == {"note_id": 99}
    added = env.anki.added[0]
    assert "<b>" in added["fields"]["Sentence"]
    assert "https://site/ch1" in added["fields"]["Source"]
    assert added["fields"]["SentenceTranslation"] == "EN:t0"
    assert "<b>な</b>" in added["fields"]["Explanation"]
    assert added["picture_jpeg"][:2] == b"\xff\xd8"
    assert added["picture_name"] == f"anki_manga_{pid[:12]}_0.jpg"


def test_cards_mark_word_known(env):
    pid = env.page()["page_id"]
    env.text(pid)
    _card(env, pid, word="道具")
    body = _explain(env, pid).json()
    assert {s["word"]: s["in_deck"] for s in body["suggestions"]}["道具"] is True


def test_cards_anki_down(tmp_path):
    e = Env(tmp_path, anki=FakeAnki(down=True))
    pid = e.page()["page_id"]
    e.text(pid)
    r = _card(e, pid)
    assert r.status_code == 503
    assert r.json() == {"error": "anki_unreachable"}


def test_cards_duplicate(tmp_path):
    e = Env(tmp_path, anki=FakeAnki(duplicate=True))
    pid = e.page()["page_id"]
    e.text(pid)
    assert _card(e, pid).status_code == 409


def test_cards_page_expired(env):
    pid = env.page()["page_id"]
    env.text(pid)
    env.store._image_path(pid).unlink()
    r = _card(env, pid)
    assert r.status_code == 410
    assert r.json() == {"error": "page_expired"}


def test_auth_check(env):
    assert env.client.get("/auth/check").status_code == 204
    assert env.client.get("/auth/check", headers={"X-AM-Token": "bad"}).status_code == 401


# --- final-review fixes ------------------------------------------------------------

def test_pair_after_reset_while_running(env):
    from anki_manga_helper.cli import main
    assert env.client.post("/pair").status_code == 200
    main(["--reset-pairing"])  # run while the server object is alive
    r = env.client.post("/pair")
    assert r.status_code == 200
    assert r.json()["token"] == cfg.load_config().token


def test_settings_does_not_undo_reset(env):
    from anki_manga_helper.cli import main
    env.client.post("/pair")
    main(["--reset-pairing"])
    r = env.client.put("/settings", json={"api_key": "sk-2"}, headers={"X-AM-Token": cfg.load_config().token})
    assert r.status_code == 200
    assert cfg.load_config().api_key == "sk-2"
    assert cfg.load_config().paired is False


def test_cards_fields_escaped(env):
    pid = env.page()["page_id"]
    env.text(pid)
    env.deepseek.explain = lambda text: {"translation": "<img src=x onerror=alert(1)>", "notes": [], "suggestions": []}
    _explain(env, pid)
    env.client.post("/cards", json={
        "page_id": pid, "bubble_id": 0, "deck": "d", "word": "<b>w</b>", "reading": "a&b",
        "meaning": "<script>x</script>", "source_url": "https://s", "source_title": "t"})
    f = env.anki.added[0]["fields"]
    assert f["Word"] == "&lt;b&gt;w&lt;/b&gt;"
    assert f["Reading"] == "a&amp;b"
    assert "<script>" not in f["Meaning"]
    assert "<img" not in f["SentenceTranslation"]


def test_health_reports_model_error(env):
    env.engine.ready = False
    env.engine.error = "download failed"
    body = env.client.get("/health").json()
    assert body["status"] == "error"
    assert body["error"] == "download failed"


@pytest.mark.parametrize("kind,status", [("no_balance", 402), ("rate_limited", 429)])
def test_explain_balance_and_rate_statuses(env, kind, status):
    pid = env.page()["page_id"]
    env.text(pid)
    env.deepseek.fail_with = ExplainError(kind)
    r = _explain(env, pid)
    assert r.status_code == status
    assert r.json() == {"error": kind}

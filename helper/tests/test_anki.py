import json

import httpx
import pytest

from anki_manga_helper.anki import FIELDS, NOTE_TYPE, AnkiClient, AnkiError, AnkiUnreachable


def client(handler_results, sent):
    def handler(request):
        body = json.loads(request.content)
        sent.append(body)
        result = handler_results(body)
        return httpx.Response(200, json=result)

    return AnkiClient(transport=httpx.MockTransport(handler))


def ok(result):
    return {"result": result, "error": None}


def test_ensure_creates_when_missing():
    sent = []
    c = client(lambda b: ok(["Basic"]) if b["action"] == "modelNames" else ok({}), sent)
    assert c.ensure_note_type() is True
    create = [b for b in sent if b["action"] == "createModel"][0]
    assert create["params"]["modelName"] == NOTE_TYPE
    assert create["params"]["inOrderFields"] == FIELDS
    assert create["version"] == 6


def test_ensure_noop_when_present():
    sent = []
    c = client(lambda b: ok(["Basic", NOTE_TYPE]), sent)
    assert c.ensure_note_type() is False
    assert not [b for b in sent if b["action"] == "createModel"]


def test_add_card_payload():
    sent = []
    c = client(lambda b: ok(1234), sent)
    nid = c.add_card("manga mining", {"Word": "角度"}, b"\xff\xd8jpg", "pic.jpg")
    assert nid == 1234
    note = sent[0]["params"]["note"]
    assert sent[0]["action"] == "addNote"
    assert note["deckName"] == "manga mining"
    assert note["modelName"] == NOTE_TYPE
    assert note["picture"][0]["fields"] == ["Picture"]
    assert note["picture"][0]["filename"] == "pic.jpg"
    assert note["options"]["duplicateScope"] == "deck"
    assert note["options"]["allowDuplicate"] is False
    assert note["tags"] == ["anki_manga"]


def test_known_words_queries_deck():
    sent = []

    def results(b):
        if b["action"] == "findNotes":
            return ok([1, 2])
        return ok([{"modelName": "Basic", "fields": {"Front": {"value": "道具", "order": 0}}},
                   {"modelName": NOTE_TYPE, "fields": {"Word": {"value": "角度", "order": 0}}}])

    k = client(results, sent).known_words("manga mining")
    assert sent[0]["params"]["query"] == 'deck:"manga mining"'
    assert k.is_known("道具", "どうぐ") and k.is_known("角度", "かくど")


def test_unreachable():
    def handler(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(AnkiUnreachable):
        AnkiClient(transport=httpx.MockTransport(handler)).deck_names()


def test_duplicate_error():
    c = client(lambda b: {"result": None, "error": "cannot create note because it is a duplicate"}, [])
    with pytest.raises(AnkiError) as e:
        c.add_card("d", {"Word": "x"}, None, "p.jpg")
    assert str(e.value) == "duplicate"

import json

import httpx
import pytest

from anki_manga_helper.deepseek import (
    SYSTEM_PROMPT,
    DeepSeekClient,
    ExplainError,
    build_request,
    parse_explanation,
)

GOOD = {
    "translation": "You can tell just by looking",
    "notes": [{"focus": "見りゃ", "explanation": "contraction of 見れば"}],
    "suggestions": [{"word": "見る", "reading": "みる", "meaning": "to see"}],
}


def test_request_shape():
    r = build_request("見りゃ分かるだろ", "deepseek-chat")
    assert r["messages"][0] == {"role": "system", "content": SYSTEM_PROMPT}
    assert r["messages"][1] == {"role": "user", "content": "見りゃ分かるだろ"}
    assert r["response_format"] == {"type": "json_object"}
    assert r["max_tokens"] == 700
    assert r["model"] == "deepseek-chat"
    assert build_request("a", "m")["messages"][0] == build_request("b", "m")["messages"][0]
    assert "JSON" in SYSTEM_PROMPT


def test_parse_truncates_and_filters():
    data = dict(GOOD)
    data["notes"] = [{"focus": str(i), "explanation": "x"} for i in range(7)]
    data["suggestions"] = [{"word": "a", "reading": "あ", "meaning": "m"}, {"word": "b", "meaning": "m"}] + [
        {"word": f"w{i}", "reading": "r", "meaning": "m"} for i in range(5)
    ]
    out = parse_explanation(json.dumps(data))
    assert len(out["notes"]) == 5
    assert len(out["suggestions"]) == 4
    assert all(s.get("reading") for s in out["suggestions"])


def test_parse_bad_json():
    with pytest.raises(ExplainError) as e:
        parse_explanation("not json")
    assert e.value.kind == "bad_response"


def test_parse_missing_translation():
    with pytest.raises(ExplainError) as e:
        parse_explanation(json.dumps({"notes": []}))
    assert e.value.kind == "bad_response"


def _transport(status, payload, seen):
    def handler(request):
        seen.append(request)
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def test_no_key():
    seen = []
    with pytest.raises(ExplainError) as e:
        DeepSeekClient(None, "deepseek-chat", transport=_transport(200, {}, seen)).explain("x")
    assert e.value.kind == "no_api_key"
    assert seen == []


def test_401():
    with pytest.raises(ExplainError) as e:
        DeepSeekClient("sk-bad", "deepseek-chat", transport=_transport(401, {"error": {}}, [])).explain("x")
    assert e.value.kind == "auth"


def test_network_error():
    def handler(request):
        raise httpx.ConnectError("down")

    with pytest.raises(ExplainError) as e:
        DeepSeekClient("sk", "deepseek-chat", transport=httpx.MockTransport(handler)).explain("x")
    assert e.value.kind == "network"


def test_success_sends_bearer():
    seen = []
    payload = {"choices": [{"message": {"content": json.dumps(GOOD)}}]}
    out = DeepSeekClient("sk-ok", "deepseek-chat", transport=_transport(200, payload, seen)).explain("見りゃ分かるだろ")
    assert out["translation"] == GOOD["translation"]
    assert seen[0].headers["authorization"] == "Bearer sk-ok"
    assert str(seen[0].url) == "https://api.deepseek.com/chat/completions"


@pytest.mark.parametrize("status,kind", [(402, "no_balance"), (429, "rate_limited")])
def test_balance_and_rate_limit(status, kind):
    with pytest.raises(ExplainError) as e:
        DeepSeekClient("sk", "deepseek-chat", transport=_transport(status, {}, [])).explain("x")
    assert e.value.kind == kind

from anki_manga_helper.text import bold_word, ruby_html, segments


def test_ruby_basic():
    html = ruby_html("道具なのです！")
    assert html.startswith("<ruby>道具<rt>どうぐ</rt></ruby>")
    assert html.endswith("なのです！")


def test_okurigana():
    assert ruby_html("分かる") == "<ruby>分<rt>わ</rt></ruby>かる"


def test_kana_untouched():
    assert all(r is None for _, r in segments("とかだったしな"))


def test_segments_cover_text():
    text = "これは坂の角度が正確に分かる道具なのです！"
    assert "".join(s for s, _ in segments(text)) == text


def test_ruby_escapes_html():
    assert "&lt;b&gt;" in ruby_html("<b>")


def test_bold_inflected():
    assert bold_word("逃げた真実を", "逃げる") == "<b>逃げ</b>た真実を"


def test_bold_exact():
    assert bold_word("坂の角度が", "角度") == "坂の<b>角度</b>が"

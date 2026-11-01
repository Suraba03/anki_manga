from anki_manga_helper.known import KnownWords, strip_field

OURS = "Manga Mining (anki_manga)"


def note(model, fields):
    return {"modelName": model, "fields": {k: {"value": v, "order": i} for i, (k, v) in enumerate(fields)}}


def test_strip_yomitan_basic_front():
    assert strip_field("如何なる") == "如何なる"
    assert strip_field("<ruby>武器<rp>(</rp><rt>ぶき</rt><rp>)</rp></ruby>") == "武器"
    assert strip_field(" 分[わ]かる") == "分かる"
    assert strip_field("&nbsp;角度<br>") == "角度"


def test_first_field_and_our_model():
    k = KnownWords.from_notes(
        [note("Basic", [("Front", "叶わない"), ("Back", "x")]), note(OURS, [("Word", "角度"), ("Reading", "かくど")])],
        OURS,
    )
    assert k.is_known("叶わない", "かなわない")
    assert k.is_known("角度", "かくど")
    assert not k.is_known("道具", "どうぐ")


def test_our_model_uses_word_field_even_if_not_first():
    k = KnownWords.from_notes([note(OURS, [("Reading", "かくど"), ("Word", "角度")])], OURS)
    assert k.is_known("角度", "かくど")


def test_kana_entry_matches_kanji():
    k = KnownWords.from_notes([note("Basic", [("Front", "わかる")])], OURS)
    assert k.is_known("分かる", "わかる")
    assert k.is_known("分かる", "ワカル")


def test_kanji_entry_not_matched_by_reading():
    k = KnownWords.from_notes([note("Basic", [("Front", "橋")])], OURS)
    assert not k.is_known("箸", "はし")

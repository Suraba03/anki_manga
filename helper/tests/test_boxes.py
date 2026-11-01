from anki_manga_helper.boxes import Bubble, merge_duplicates, reading_order


def b(box, i=0):
    return Bubble(id=i, box=tuple(float(v) for v in box), vertical=True, font_size=20.0, lines=[])


def test_merge_duplicates_keeps_one():
    out = merge_duplicates([b((256, 601, 289, 746)), b((259, 599, 292, 749), 1)])
    assert len(out) == 1


def test_merge_keeps_separate():
    out = merge_duplicates([b((0, 0, 10, 10)), b((20, 0, 30, 10), 1)])
    assert len(out) == 2


def test_merge_contained_box():
    out = merge_duplicates([b((0, 0, 100, 100)), b((10, 10, 50, 50), 1)])
    assert [x.box for x in out] == [(0.0, 0.0, 100.0, 100.0)]


def test_reading_order_right_to_left_then_down():
    a = b((800, 100, 850, 300), 7)
    bb = b((100, 120, 150, 320), 8)
    c = b((900, 700, 950, 900), 9)
    out = reading_order([c, bb, a], page_width=1000)
    assert [x.box for x in out] == [a.box, bb.box, c.box]
    assert [x.id for x in out] == [0, 1, 2]


def test_to_json_keys():
    assert set(b((0, 0, 1, 1)).to_json()) == {"id", "box", "vertical", "font_size", "lines"}

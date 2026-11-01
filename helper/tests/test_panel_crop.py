import cv2
import numpy as np

from anki_manga_helper.panel_crop import crop_jpeg, find_panel_box


def page_with_panels():
    img = np.full((1400, 1000, 3), 255, dtype=np.uint8)
    cv2.rectangle(img, (20, 20), (980, 680), (0, 0, 0), 4)
    cv2.rectangle(img, (20, 720), (980, 1380), (0, 0, 0), 4)
    cv2.putText(img, "abc", (300, 300), cv2.FONT_HERSHEY_SIMPLEX, 3, (0, 0, 0), 5)  # noise inside panel
    return img


def test_finds_enclosing_panel():
    box = find_panel_box(page_with_panels(), (700, 100, 760, 300))
    assert all(abs(a - b) <= 10 for a, b in zip(box, (20, 20, 980, 680))), box


def test_finds_lower_panel():
    box = find_panel_box(page_with_panels(), (100, 900, 160, 1100))
    assert all(abs(a - b) <= 10 for a, b in zip(box, (20, 720, 980, 1380))), box


def test_fallback_when_no_panel():
    img = np.full((1400, 1000, 3), 255, dtype=np.uint8)
    assert find_panel_box(img, (500, 500, 540, 600)) == (425, 425, 615, 675)


def test_fallback_clamped():
    img = np.full((1400, 1000, 3), 255, dtype=np.uint8)
    assert find_panel_box(img, (0, 0, 40, 100)) == (0, 0, 115, 175)


def test_crop_jpeg_size():
    data = crop_jpeg(page_with_panels(), (20, 20, 980, 680))
    assert data[:2] == b"\xff\xd8"
    out = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    assert max(out.shape[:2]) == 600

# anki_manga v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome extension + local Python helper that makes manga speech bubbles on web readers hoverable by Yomitan and explains a clicked bubble in a side panel (furigana, translation, grammar notes, card suggestions with one-click Anki cards).

**Architecture:** A local helper (FastAPI on 127.0.0.1) runs comic-text-detector + manga_ocr via mokuro, adds furigana with fugashi, calls DeepSeek and AnkiConnect, and caches everything in SQLite. The MV3 extension finds manga `<img>`s on sites the user has enabled, sends the image bytes to the helper, draws an invisible per-bubble text layer, and shows the side panel.

**Tech Stack:**
- Python 3.11, uv, mokuro 0.2.5 (pulls manga_ocr, torch, fugashi, unidic_lite, opencv), FastAPI + uvicorn, httpx, platformdirs, pytest
- Chrome MV3, plain JavaScript with no bundler, `node --test` for the pure content-script modules

**Spec:** `docs/superpowers/specs/2026-11-01-manga-reader-design.md`. Read it first; this plan argues from it.

## Global Constraints

**Licensing and secrets**
- License **GPL-3.0**. The helper depends on `mokuro` as a library and uses its `TextDetector` / model cache. Don't reimplement the detector.
- Never commit manga images, `yomitan-settings-*.json`, API keys or `.superpowers/`. `.gitignore` already covers the root images and the settings export.
- Tests needing real pages read them from `$ANKI_MANGA_SAMPLES` (a local folder) and are skipped when it is unset.

**Helper**
- Binds **127.0.0.1 only**, default port **47812**.
- Every endpoint except `GET /health` and `POST /pair` requires header `X-AM-Token`.
- All requests are rejected unless `Origin` starts with `chrome-extension://` and `Host` is `127.0.0.1:<port>` or `localhost:<port>`.
- Config (API key, token, `paired` flag) lives in `platformdirs.user_config_dir("anki_manga")` (`~/Library/Application Support/anki_manga/` on macOS), in a file with mode `0600`.
- Cache lives in `platformdirs.user_cache_dir("anki_manga")`.
- Env `ANKI_MANGA_HOME` overrides both (used by tests).

**OCR and DeepSeek**
- OCR **once per bubble** on the bubble crop: `MangaOcr(crop)` with a 4px pad. Not per line.
- DeepSeek is called **only** from `POST /explain`, which the panel calls **only** on an explicit bubble click.
  - Cache key: `sha256(PROMPT_VERSION + normalized text)`. A failed call caches nothing.
  - Model from config, default `deepseek-chat`.
  - `response_format={"type":"json_object"}`, `max_tokens=700`.
  - A fixed system prompt as the first message, byte-identical across calls, so prefix caching applies.
  - Explanations are in English.

**Anki**
- Note type name: **`Manga Mining (anki_manga)`**.
- Fields in order: `Word, Reading, Meaning, Sentence, SentenceFurigana, SentenceTranslation, Explanation, Picture, Source`.

**Text layer**
- One absolutely positioned element per bubble, holding the bubble's text.
- Line chunks inside it are `display:inline-block` spans. No `<br>`, no block/flex/grid children, no `position:absolute/fixed/sticky` children.
- Text is invisible via `color: transparent`. Never use `opacity:0`, `visibility:hidden` or `font-size:0` on it or its ancestors.
- Pointer events pass through everywhere except bubble elements.
- Nothing is injected on sites that aren't enabled.

**Extension**
- Host permissions are requested per site at enable time (optional host permissions). The only install-time host permission is `http://127.0.0.1/*`.

## Review Focus

Inputs the spec implies but most tests wouldn't hit, most likely first. Each has a test in its owning task.

1. **Lazy placeholders:**
   - An `<img>` whose `src` is a `data:` placeholder with the real URL in `data-src` must be processed using `data-src` and never sent as the placeholder.
   - When the site later swaps `src` to that same URL, the page must not be processed twice.

   Task 13 tests this (`realImageUrl`, `pageKey`).
2. **Token lost after reinstalling the extension:** `/pair` must answer `409` with the text `anki-manga-helper --reset-pairing`, and that command must make pairing possible again. The panel shows that text. Tested in Tasks 11 and 12.
3. **DeepSeek failure** (bad key 401, network error, malformed JSON):
   - `/explain` returns an error the panel can show.
   - Nothing is cached.
   - The next click calls DeepSeek again.

   Tested in Tasks 9 and 11.
4. **Anki closed:** `/explain` still returns translation, notes and suggestions, with `anki: "unreachable"` and `in_deck: null`. `/cards` returns `503 {"error":"anki_unreachable"}`. Tested in Task 11.
5. **Image shown at a different size than its pixels** (responsive width, zoom, resize after the overlay is drawn): bubble rects must scale from natural to displayed size and be recomputed on resize. Tested in Task 14 (`layoutBubble` at two scales).

---

## File Structure

```
helper/
  pyproject.toml                 # package anki-manga-helper, script entry
  src/anki_manga_helper/
    config.py                    # paths, Config load/save, token, API key
    boxes.py                     # Bubble dataclass, merge_duplicates, reading_order
    engine.py                    # Engine: mokuro TextDetector + MangaOcr, GPU lock
    store.py                     # SQLite: pages, bubble texts, explanations; page image files
    scheduler.py                 # OcrScheduler: priority queue, worker thread, subscriptions
    text.py                      # furigana segments/ruby html, bold_word
    known.py                     # strip_field, KnownWords, is_known
    anki.py                      # AnkiClient (AnkiConnect)
    deepseek.py                  # build_request, parse_explanation, DeepSeekClient
    panel_crop.py                # find_panel_box, crop_jpeg
    server.py                    # create_app(...): security middleware + endpoints
    cli.py                       # anki-manga-helper entry: serve / --reset-pairing
  tests/                         # pytest, one file per module + test_server.py
extension/
  manifest.json
  background.js                  # module service worker: routing, image fetch, SSE relay, capture fallback
  lib/helper-client.js           # ES module: fetch wrapper for the helper (token, errors)
  content/page-finder.js         # pure: isMangaImage, realImageUrl, pageKey
  content/layout.js              # pure: splitTextIntoLines, layoutBubble
  content/overlay.js             # DOM: draw/update bubble layer, hover/click, toggle key
  content/main.js                # wiring: observers, messaging
  panel/panel.html panel.css panel.js
  package.json                   # only for `node --test`
  test/page-finder.test.js test/layout.test.js
README.md  LICENSE
```

Content scripts are classic scripts sharing `globalThis.AnkiManga`. Each pure module ends with:

```js
if (typeof module !== "undefined") module.exports = X; else (globalThis.AnkiManga ??= {}).X = X;
```

so that `node --test` can `require` it.

---

### Task 1: Helper package skeleton + config

**Files:**
- Create: `helper/pyproject.toml`, `helper/src/anki_manga_helper/__init__.py`, `helper/src/anki_manga_helper/config.py`, `helper/tests/conftest.py`, `helper/tests/test_config.py`, `LICENSE` (GPL-3.0 text)
- Modify: `.gitignore` (add `helper/.venv/`, `extension/node_modules/`)

**Interfaces:**
- Produces:
  - `config_dir() -> Path`, `cache_dir() -> Path`. Both honour `ANKI_MANGA_HOME` (`$HOME/config`, `$HOME/cache`).
  - `@dataclass Config(token: str, paired: bool, api_key: str | None, deepseek_model: str = "deepseek-chat", port: int = 47812)`
  - `load_config() -> Config`: creates the file with a fresh `secrets.token_urlsafe(32)` token on first call.
  - `save_config(c: Config) -> None`: writes JSON with mode `0600`.
  - `__version__ = "0.1.0"`.

pyproject:
- `requires-python = ">=3.10,<3.13"`
- deps: `mokuro==0.2.5, fastapi, uvicorn, httpx, platformdirs`
- dev: `pytest`
- script: `anki-manga-helper = "anki_manga_helper.cli:main"`
- pytest marker: `models` (real-model tests)

conftest: an autouse fixture sets `ANKI_MANGA_HOME` to `tmp_path`.

- [ ] **Step 1: Write failing tests** in `tests/test_config.py`:
  - `test_first_load_creates_token`: `load_config().token` has length ≥ 40 and `paired is False`; a second `load_config()` returns the same token.
  - `test_save_roundtrip_and_mode`: set `api_key="sk-x"`, save, reload, and `api_key == "sk-x"`; `stat.S_IMODE(os.stat(file).st_mode) == 0o600`.
  - `test_home_override`: `config_dir()` is under `os.environ["ANKI_MANGA_HOME"]`.
- [ ] **Step 2:** `cd helper && uv sync --extra dev && uv run pytest tests/test_config.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `config.py`.
- [ ] **Step 4:** `uv run pytest tests/test_config.py -v`. Expected: 3 passed.
- [ ] **Step 5:** Commit: `feat(helper): package skeleton and config`.

### Task 2: Bubble boxes: dedupe and reading order

**Files:** Create `helper/src/anki_manga_helper/boxes.py`, `helper/tests/test_boxes.py`

**Interfaces:**
- Produces:
  - `@dataclass Bubble(id: int, box: tuple[float, float, float, float], vertical: bool, font_size: float, lines: list[list[tuple[float, float]]])`. `box` is x1,y1,x2,y2 in image pixels; `lines` are 4-point quads.
  - `Bubble.to_json() -> dict` with keys `id, box, vertical, font_size, lines`.
  - `merge_duplicates(bubbles: list[Bubble], iou: float = 0.6) -> list[Bubble]`: when two boxes overlap with IoU ≥ `iou`, or one is ≥ 90% inside the other, keep the larger.
  - `reading_order(bubbles: list[Bubble], page_width: int) -> list[Bubble]`: sorts into manga reading order and **reassigns ids 0..n-1** in that order.

Ordering algorithm (not determined by the tests alone):
1. Group bubbles into rows: a bubble joins the current row when its vertical centre lies within the row's y-span.
2. Order rows top→bottom.
3. Within a row, order by x2 descending (right→left).

- [ ] **Step 1: Write failing tests:**
  - `test_merge_duplicates_keeps_one`: two boxes `(256,601,289,746)` and `(259,599,292,749)` → 1 bubble.
  - `test_merge_keeps_separate`: boxes `(0,0,10,10)` and `(20,0,30,10)` → 2.
  - `test_reading_order_right_to_left_then_down`: boxes A `(800,100,850,300)`, B `(100,120,150,320)`, C `(900,700,950,900)` → order A, B, C with ids 0, 1, 2.
- [ ] **Step 2:** Run `uv run pytest tests/test_boxes.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): bubble dedupe and reading order`.

### Task 3: Engine (detector + OCR)

**Files:** Create `helper/src/anki_manga_helper/engine.py`, `helper/tests/test_engine_models.py`

**Interfaces:**
- Consumes: `Bubble`, `merge_duplicates`, `reading_order` (Task 2).
- Produces:
  - `class Engine`:
    - `__init__(self)`: loads nothing.
    - `load(self) -> None`: slow.
    - `ready: bool`
    - `detect(self, img: np.ndarray) -> list[Bubble]`: RGB array; result is deduped and in reading order.
    - `ocr(self, img: np.ndarray, bubble: Bubble) -> str`
  - A `threading.Lock` held around every model call.
  - `decode_image(data: bytes) -> np.ndarray`: RGB; raises `ValueError` on undecodable bytes.

Use these as in the spike:
- `from comic_text_detector.inference import TextDetector`
- `mokuro.cache.cache.comic_text_detector` for the weights path
- device `"mps"` if available, else `"cpu"`
- `TextDetector(model_path=..., input_size=1024, device=..., act="leaky")`
- `MangaOcr("kha-white/manga-ocr-base")`

Detection: `_, _, blks = detector(img, refine_mode=1, keep_undetected_mask=True)`, then map each `blk` to a Bubble:
- `box = blk.xyxy`
- `vertical = blk.vertical`
- `font_size = blk.font_size`
- `lines = [l.tolist() for l in blk.lines_array()]`

OCR: crop `box` padded by 4px and clamped to the image, convert to PIL, call `mocr(crop)`.

- [ ] **Step 1: Write failing tests**, marked `@pytest.mark.models` and skipped unless `ANKI_MANGA_SAMPLES` is set:
  - `test_detect_and_ocr_sample_a`:
    - Load `$ANKI_MANGA_SAMPLES/1e09e93d853dac2e659ec5f4b70b46bb009.jpg`.
    - Detect gives 11 bubbles.
    - OCR of the joined texts contains `"これは坂の角度が正確に分かる道具なのです！"`.
    - The first bubble's text is `"昨日は"`.
  - `test_no_duplicate_majika`: in `8e53654f98e2a48be4e65659e5f79b68010.jpg`, OCR'd texts contain `"まじか！"` exactly once.
  - `test_decode_rejects_garbage`: `decode_image(b"nope")` raises `ValueError`. Not marked.
- [ ] **Step 2:** Run `ANKI_MANGA_SAMPLES=$PWD/.. uv run pytest tests/test_engine_models.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: 3 passed. This downloads models on first run.
- [ ] **Step 5:** Commit: `feat(helper): detection and per-bubble OCR engine`.

### Task 4: Store (SQLite cache + page images)

**Files:** Create `helper/src/anki_manga_helper/store.py`, `helper/tests/test_store.py`

**Interfaces:**
- Produces `class Store(path: Path)`. SQLite with `check_same_thread=False` and an internal lock. Methods:
  - `page_id_for(data: bytes) -> str`: sha256 hex.
  - `save_page(page_id, width, height, bubbles: list[dict]) -> None`
  - `get_page(page_id) -> dict | None`: `{"width","height","bubbles":[...with "text": str|None]}`
  - `set_text(page_id, bubble_id, text) -> None`
  - `get_text(page_id, bubble_id) -> str | None`
  - `save_image(page_id, data: bytes) -> None`
  - `load_image(page_id) -> bytes | None`: files go under `cache_dir()/pages/`; keep at most 300 files, deleting the oldest by mtime.
  - `explanation_key(text: str) -> str`: `sha256(f"{PROMPT_VERSION}\n{unicodedata.normalize('NFKC', text).strip()}")`, with `PROMPT_VERSION` imported from `deepseek.py` (Task 9). Until then, define `PROMPT_VERSION = 1` in `deepseek.py` as a stub.
  - `get_explanation(key) -> dict | None`
  - `save_explanation(key, data: dict) -> None`

- [ ] **Step 1: Write failing tests:**
  - `test_page_roundtrip_with_texts`: save a page with 2 bubbles, `set_text(pid, 1, "あ")`, then `get_page` shows texts `[None, "あ"]`.
  - `test_same_bytes_same_id`: `page_id_for(b"x") == page_id_for(b"x") != page_id_for(b"y")`.
  - `test_image_pruning`: with the cap patched to 3, saving 5 images leaves 3 and the oldest return `None`.
  - `test_explanation_key_normalizes`: `explanation_key(" あ！ ") == explanation_key("あ!")`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): sqlite cache store`.

### Task 5: OCR scheduler

**Files:** Create `helper/src/anki_manga_helper/scheduler.py`, `helper/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `Engine.ocr`, `Store.set_text/get_text/get_page`, `decode_image`.
- Produces `class OcrScheduler(engine, store)`:
  - `start() -> None`: one daemon worker thread.
  - `enqueue_page(page_id: str, img: np.ndarray, bubbles: list[Bubble]) -> None`: queues bubbles without cached text, in id order, priority `10`.
  - `prioritize(page_id: str, bubble_id: int) -> None`: re-queues at priority `0`; a no-op if already done.
  - `wait_text(page_id, bubble_id, timeout: float) -> str | None`: prioritizes, then blocks.
  - `async subscribe(page_id) -> AsyncIterator[tuple[int, str]]`: yields already-known texts first, then new ones as they finish, and ends when every bubble of the page has text. Uses `loop.call_soon_threadsafe` to an `asyncio.Queue`.

  Lower number = earlier; ties by insertion order. Keep a per-page decoded image only while it has queued bubbles.

- [ ] **Step 1: Write failing tests** with `FakeEngine.ocr` returning `f"t{bubble.id}"` and recording call order:
  - `test_processes_in_reading_order`: 3 bubbles → call order `[0, 1, 2]` and the store has all 3 texts.
  - `test_prioritize_jumps_queue`:
    - FakeEngine blocks on an Event during the first call.
    - Enqueue 5 bubbles, `prioritize(pid, 4)`, release.
    - Order starts `[0, 4, ...]`.
  - `test_cached_bubbles_not_reprocessed`: after a full run, enqueueing the same page again makes no new `ocr` calls.
  - `test_subscribe_yields_all_then_ends`: `asyncio.run` collects `{0: "t0", 1: "t1", 2: "t2"}`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): prioritized OCR scheduler`.

### Task 6: Furigana and word bolding

**Files:** Create `helper/src/anki_manga_helper/text.py`, `helper/tests/test_text.py`

**Interfaces:**
- Produces:
  - `segments(text: str) -> list[tuple[str, str | None]]`: (surface, hiragana reading or None for kana/punctuation).
  - `ruby_html(text: str) -> str`: HTML-escaped, with `<ruby>漢<rt>かん</rt></ruby>`.
  - `bold_word(text: str, word: str) -> str`: wraps in `<b>…</b>` either the exact `word` occurrences, or else the tokens whose lemma equals `word`; text is HTML-escaped.

Uses `fugashi.Tagger()` (unidic-lite), with the reading from `word.feature.kana` (fall back to `pron`) converted with `jaconv.kata2hira`.

Okurigana alignment, which the tests pin and the library doesn't decide: for a token with kanji, strip the longest common kana **suffix** and **prefix** between surface and reading. Emit ruby only over the remaining core, and the stripped kana as plain segments.

- [ ] **Step 1: Write failing tests:**
  - `test_ruby_basic`: `ruby_html("道具なのです！")` starts with `"<ruby>道具<rt>どうぐ</rt></ruby>"` and ends with `"なのです！"`.
  - `test_okurigana`: `ruby_html("分かる")` → `"<ruby>分<rt>わ</rt></ruby>かる"`.
  - `test_kana_untouched`: `segments("とかだったしな")` contains only `None` readings.
  - `test_bold_inflected`: `bold_word("逃げた真実を", "逃げる")` → `"<b>逃げ</b>た真実を"`.
  - `test_bold_exact`: `bold_word("坂の角度が", "角度")` → `"坂の<b>角度</b>が"`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): furigana and word bolding`.

### Task 7: Known-words matching

**Files:** Create `helper/src/anki_manga_helper/known.py`, `helper/tests/test_known.py`

**Interfaces:**
- Produces:
  - `strip_field(value: str) -> str`, in this order:
    1. remove `<rt>…</rt>` and `<rp>…</rp>`
    2. remove Anki `[reading]` furigana brackets
    3. remove HTML tags
    4. unescape entities
    5. strip whitespace
  - `@dataclass KnownWords(words: set[str], kana_entries: set[str])`
  - `KnownWords.from_notes(notes: list[dict], our_model: str) -> KnownWords`:
    - `notes` are AnkiConnect `notesInfo` dicts.
    - For `our_model`, use field `Word`; otherwise use the field with `order == 0`.
    - Entries made only of kana go into `kana_entries` (as hiragana) **and** `words`.
  - `KnownWords.is_known(word: str, reading: str) -> bool`: true if `word` is in `words`, or `kata2hira(reading)` is in `kana_entries`.

- [ ] **Step 1: Write failing tests:**
  - `test_strip_yomitan_basic_front`: `strip_field("如何なる")` → `"如何なる"`; `strip_field("<ruby>武器<rp>(</rp><rt>ぶき</rt><rp>)</rp></ruby>")` → `"武器"`; `strip_field(" 分[わ]かる")` → `"分かる"`.
  - `test_first_field_and_our_model`: a Basic note with `Front` order 0 `"叶わない"` and our-model note `Word="角度"` → both words known.
  - `test_kana_entry_matches_kanji`: notes with first field `"わかる"` → `is_known("分かる", "わかる")` is true.
  - `test_kanji_entry_not_matched_by_reading`: notes with `"橋"` (はし) → `is_known("箸", "はし")` is false.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): known-word matching`.

### Task 8: AnkiConnect client

**Files:** Create `helper/src/anki_manga_helper/anki.py`, `helper/tests/test_anki.py`

**Interfaces:**
- Consumes: `KnownWords` (Task 7).
- Produces:
  - `NOTE_TYPE = "Manga Mining (anki_manga)"`
  - `FIELDS = ["Word","Reading","Meaning","Sentence","SentenceFurigana","SentenceTranslation","Explanation","Picture","Source"]`
  - `class AnkiUnreachable(Exception)`, `class AnkiError(Exception)`
  - `class AnkiClient(url="http://127.0.0.1:8765", transport: httpx.BaseTransport | None = None)`. A connect error or timeout of 3s raises `AnkiUnreachable`; a non-null `error` raises `AnkiError`. Methods:
    - `deck_names() -> list[str]`
    - `ensure_note_type() -> bool`: True if created.
    - `known_words(deck: str) -> KnownWords`: `findNotes` with query `deck:"<deck>"`, then `notesInfo` in batches of 500.
    - `add_card(deck: str, fields: dict[str, str], picture_jpeg: bytes | None, picture_name: str) -> int`

`add_card` sends `addNote` with:
- `options={"allowDuplicate": False, "duplicateScope": "deck"}`
- `tags=["anki_manga"]`
- `picture=[{"data": base64, "filename": picture_name, "fields": ["Picture"]}]` when a picture is given

A duplicate error raises `AnkiError("duplicate")`.

`ensure_note_type` calls `modelNames`; if the name is missing, it calls `createModel` with:
- `inOrderFields=FIELDS`
- one card template named `"Recognition"`: front shows Word + Sentence; back is `{{FrontSide}}<hr id=answer>` plus Reading, Meaning, SentenceFurigana, SentenceTranslation, Explanation, Picture, Source
- clean CSS (builder's styling)

- [ ] **Step 1: Write failing tests** using `httpx.MockTransport` that records requests:
  - `test_ensure_creates_when_missing`: `modelNames` returns `["Basic"]`; a `createModel` request is sent with `inOrderFields == FIELDS` and `modelName == NOTE_TYPE`; returns True.
  - `test_ensure_noop_when_present`: no `createModel`; returns False.
  - `test_add_card_payload`: params have `note.deckName == "manga mining"`, `note.modelName == NOTE_TYPE`, `picture[0].fields == ["Picture"]`, and `options.duplicateScope == "deck"`.
  - `test_unreachable`: a transport that raises `httpx.ConnectError` → `AnkiUnreachable`.
  - `test_duplicate_error`: response `{"result": null, "error": "cannot create note because it is a duplicate"}` → `AnkiError` with `str(e) == "duplicate"`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): AnkiConnect client and note type`.

### Task 9: DeepSeek client

**Files:** Modify `helper/src/anki_manga_helper/deepseek.py` (replace the Task 4 stub). Create `helper/tests/test_deepseek.py`.

**Interfaces:**
- Produces:
  - `PROMPT_VERSION = 1`
  - `SYSTEM_PROMPT: str`, a module constant
  - `class ExplainError(Exception)` with `.kind` in `{"no_api_key","auth","network","bad_response"}`
  - `build_request(text: str, model: str) -> dict`
  - `parse_explanation(content: str) -> dict`
  - `class DeepSeekClient(api_key: str | None, model: str, transport=None)` with `.explain(text: str) -> dict`, posting to `https://api.deepseek.com/chat/completions` with a 30s timeout.

Explanation dict, exact shape:
```json
{"translation": "...", "notes": [{"focus": "なのです", "explanation": "..."}],
 "suggestions": [{"word": "角度", "reading": "かくど", "meaning": "angle"}]}
```

`SYSTEM_PROMPT` wording is the builder's choice. It must:
- contain the word "JSON" and this exact schema
- ask for 2–5 notes about grammar/structure ("why it's written this way", not word glosses)
- ask for 2–4 suggestions in dictionary form with hiragana reading and a short gloss
- ask for English

The user message is just the bubble text. Don't put any variable content in the system prompt.

`parse_explanation`:
- truncates notes to 5 and suggestions to 4
- drops suggestions missing `word` or `reading`
- raises `ExplainError("bad_response")` on invalid JSON or a missing `translation`

- [ ] **Step 1: Write failing tests:**
  - `test_request_shape`: `messages[0] == {"role":"system","content":SYSTEM_PROMPT}`, `messages[1]["content"] == "見りゃ分かるだろ"`, `response_format == {"type":"json_object"}`, `max_tokens == 700`, `model == "deepseek-chat"`; and `build_request("a", m)["messages"][0] == build_request("b", m)["messages"][0]`.
  - `test_parse_truncates_and_filters`: 7 notes → 5; suggestions with one missing `reading` → dropped.
  - `test_parse_bad_json`: `parse_explanation("not json")` raises `ExplainError` with `.kind == "bad_response"`.
  - `test_no_key`: `DeepSeekClient(None, "deepseek-chat").explain("x")` → kind `no_api_key`, with no request sent.
  - `test_401`: MockTransport 401 → kind `auth`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): DeepSeek explanation client`.

### Task 10: Panel crop for the Picture field

**Files:** Create `helper/src/anki_manga_helper/panel_crop.py`, `helper/tests/test_panel_crop.py`

**Interfaces:**
- Produces:
  - `find_panel_box(img: np.ndarray, bubble_box: tuple) -> tuple[int, int, int, int]`
  - `crop_jpeg(img: np.ndarray, box: tuple, max_side: int = 600, quality: int = 80) -> bytes`

Approach (builder's leeway per spec §4.7):
1. Threshold dark pixels, then `cv2.findContours` with `RETR_LIST`.
2. Keep near-rectangular contours (`approxPolyDP` with 4 points) whose area is ≥ 3% of the page.
3. Pick the smallest one that contains the bubble's centre.
4. If there is none, fall back to the bubble box expanded by `0.75 × max(w, h)` on each side, clamped to the image.

- [ ] **Step 1: Write failing tests** on synthetic images: a white 1000×1400 page with two black 4px-bordered rectangles `(20,20,980,680)` and `(20,720,980,1380)`:
  - `test_finds_enclosing_panel`: a bubble at `(700,100,760,300)` → box within 10px of `(20,20,980,680)`.
  - `test_fallback_when_no_panel`: on an all-white page, bubble `(500,500,540,600)` → `(425,425,615,675)`.
  - `test_crop_jpeg_size`: output decodes, long side == 600, starts with `b"\xff\xd8"`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(helper): comic panel crop`.

### Task 11: HTTP server

**Files:** Create `helper/src/anki_manga_helper/server.py`, `helper/tests/test_server.py`

**Interfaces:**
- Consumes: everything above.
- Produces `create_app(config: Config, engine, store: Store, scheduler: OcrScheduler, anki: AnkiClient, deepseek_factory: Callable[[Config], DeepSeekClient]) -> FastAPI`. All handlers that touch models, the DB or httpx run in the threadpool, as plain `def` endpoints.

**Middleware**, applied to every request, in this order:
1. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, else 403 `{"error":"bad_host"}`.
2. `Origin` must start with `chrome-extension://`, else 403 `{"error":"bad_origin"}`.
3. Except `GET /health` and `POST /pair`: `X-AM-Token` must equal `config.token`, else 401 `{"error":"bad_token"}`.

Add CORS response headers for the requesting extension origin, including preflight for `X-AM-Token`.

**Endpoints** (exact):

| Method & path | Behaviour |
|---|---|
| `GET /health` | `{"status": "warming" \| "ready", "version", "paired", "has_api_key"}` |
| `POST /pair` | If not paired: set `paired=True`, save, return `{"token"}`. Else 409 `{"error":"already_paired","hint":"Run: anki-manga-helper --reset-pairing"}` |
| `PUT /settings` | Body `{"api_key"}`. Saves; returns `{"has_api_key": true}` |
| `POST /pages?url=<image url>` | Raw image body. 503 `{"error":"warming"}` if `not engine.ready`; 400 `{"error":"bad_image"}` if undecodable. Cached page: return it without detecting. Else detect, `save_page`, `save_image`, `enqueue_page`. Returns `{"page_id","width","height","bubbles":[Bubble.to_json() + "text"]}` |
| `GET /pages/{pid}/events` | SSE: `data: {"bubble_id": n, "text": "..."}` per bubble from `scheduler.subscribe`, then `event: done` |
| `POST /pages/{pid}/bubbles/{bid}/prioritize` | 204 |
| `GET /pages/{pid}/bubbles/{bid}` | `wait_text(timeout=10)`. Returns `{"text","ruby_html"}`; 404 for an unknown page; 504 on timeout |
| `GET /anki/decks` | `{"decks": [...]}`, calling `ensure_note_type()` once per process first. 503 `{"error":"anki_unreachable"}` |
| `POST /anki/refresh` | Body `{"deck"}`. Reloads the in-memory `KnownWords` for that deck; 204, or 503 |
| `POST /explain` | Body `{"page_id","bubble_id","deck"}` → see below |
| `POST /cards` | Body `{"page_id","bubble_id","deck","word","reading","meaning","source_url","source_title"}` → see below |

`POST /explain`:
- Takes the text from the store.
- Explanation from the cache, or from `deepseek_factory(config).explain(text)`, which is saved **only on success**.
- Then marks `in_deck` on each suggestion using that deck's `KnownWords`, loading it if absent.
- Response: `{"text","translation","notes","suggestions":[...+"in_deck": bool | null],"cached": bool,"anki": "ok" | "unreachable"}`.
- `ExplainError` → 400 for `no_api_key`, 401 for `auth`, 502 otherwise, as `{"error": kind}`.

`POST /cards` builds the fields:
- Word, Reading, Meaning
- Sentence = `bold_word(text, word)`
- SentenceFurigana = `ruby_html(text)`
- SentenceTranslation and Explanation from the cached explanation, with notes rendered as `<b>focus</b> — explanation<br>`
- Source = `<a href="{source_url}">{source_title}</a>`
- Picture = `crop_jpeg(img, find_panel_box(img, bubble.box))`, named `anki_manga_{pid[:12]}_{bid}.jpg`

It adds the word to the deck's `KnownWords` and returns `{"note_id"}`. Errors:
- `AnkiUnreachable` → 503 `{"error":"anki_unreachable"}`
- `AnkiError("duplicate")` → 409 `{"error":"duplicate"}`
- a missing page image → 410 `{"error":"page_expired"}`

- [ ] **Step 1: Write failing tests** with `TestClient` and fakes. Use FakeEngine from Task 5, plus a `ready` flag and a `detect` that returns 2 bubbles. Use a FakeAnki and a FakeDeepSeek that counts calls. Default headers: `Host: 127.0.0.1:47812`, `Origin: chrome-extension://abc`, and the token.
  - `test_rejects_bad_origin`: `Origin: https://evil.example` on `/health` → 403.
  - `test_rejects_bad_host`: `Host: evil.example:47812` → 403.
  - `test_requires_token`: `/anki/decks` without the token → 401.
  - `test_pair_once_then_409_with_hint`: first → 200 with the token; second → 409, and the body's `hint` contains `"anki-manga-helper --reset-pairing"`.
  - `test_pages_warming`: `engine.ready=False` → 503 `{"error":"warming"}`.
  - `test_pages_cached_no_redetect`: posting the same bytes twice → `detect` called once and the same `page_id`.
  - `test_explain_cached_once`: two `/explain` calls on the same bubble → FakeDeepSeek called once; the second has `cached: true`.
  - `test_explain_failure_not_cached`: FakeDeepSeek raises `ExplainError("bad_response")` → 502; it then succeeds on the next call, which makes a 2nd DeepSeek call.
  - `test_explain_without_anki`: FakeAnki raises `AnkiUnreachable` → 200 with `anki == "unreachable"` and every `in_deck is None`.
  - `test_explain_marks_in_deck`: KnownWords has `"道具"` → that suggestion has `in_deck: true`.
  - `test_cards_fields_and_picture`: FakeAnki receives `fields["Sentence"]` containing `"<b>"`, `fields["Source"]` containing the URL, and `picture_jpeg` starting `b"\xff\xd8"`.
  - `test_cards_anki_down`: → 503 `anki_unreachable`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `uv run pytest -v -m "not models"`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat(helper): HTTP API with origin/token guard`.

### Task 12: CLI entry point

**Files:** Create `helper/src/anki_manga_helper/cli.py`, `helper/tests/test_cli.py`

**Interfaces:**
- Produces `main(argv: list[str] | None = None) -> int`:
  - `anki-manga-helper` (serve): build the objects, start `engine.load()` in a background thread, start the scheduler, and run uvicorn on `127.0.0.1:config.port`. Print one line: `anki_manga helper on http://127.0.0.1:<port> — loading models (first run downloads ~1 GB)…`, then `ready` when loaded.
  - `anki-manga-helper --reset-pairing`: sets `paired=False`, rotates the token, prints `Pairing reset. Open the anki_manga panel to reconnect.`, and returns 0.

- [ ] **Step 1: Write failing test** `test_reset_pairing`: save a config with `paired=True`; `main(["--reset-pairing"]) == 0`; after reload, `paired is False` and the token changed.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Then do a manual check:
  - Run `uv run anki-manga-helper` and wait for `ready`.
  - `curl -s -H 'Origin: chrome-extension://x' http://127.0.0.1:47812/health` shows `"status":"ready"`.
  - The same request without `Origin` → 403.
- [ ] **Step 5:** Commit: `feat(helper): CLI with reset-pairing`.

### Task 13: Extension skeleton, pairing, settings, page finder, site enabling

**Files:**
- Create: `extension/manifest.json`, `extension/background.js`, `extension/lib/helper-client.js`, `extension/content/page-finder.js`, `extension/panel/panel.html`, `extension/panel/panel.css`, `extension/panel/panel.js`, `extension/package.json`, `extension/test/page-finder.test.js`

**Interfaces:**
- `manifest.json`:
  - MV3, name `anki_manga`
  - permissions `["storage","sidePanel","scripting","tabs"]`
  - `host_permissions: ["http://127.0.0.1/*"]`, `optional_host_permissions: ["*://*/*"]`
  - `background: {service_worker: "background.js", type: "module"}`
  - `side_panel.default_path: "panel/panel.html"`
  - an action with no popup; background calls `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})`
- `lib/helper-client.js` (ES module):
  - `HELPER = "http://127.0.0.1:47812"`
  - `async ensurePaired() -> {ok: true} | {ok: false, error: "helper_unreachable" | "already_paired", hint?}`: stores the token in `chrome.storage.local.token`.
  - `async call(path, {method, json, body, headers}) -> Response`: adds `X-AM-Token`; throws `HelperError(error, status)` with the server's `error` string, or `"helper_unreachable"`.
- `content/page-finder.js` (pure): `PageFinder = {isMangaImage(w, h), realImageUrl(img), pageKey(url)}`
  - `isMangaImage`: true if `min(w,h) >= 400 && max(w,h) >= 600`, using natural size when known, else the `width`/`height` attributes.
  - `realImageUrl`: returns `img.dataset.src || img.getAttribute("data-original") || img.src` when that is not a `data:` URL, else `null`.
  - `pageKey`: the URL with the hash removed.
- Messages (background `chrome.runtime.onMessage`, exact `type` strings):
  - `am:enable-site {origin, tabId}`: the panel has already been granted `origin + "/*"`. Background calls `chrome.scripting.registerContentScripts([{id: origin, matches: [origin + "/*"], js: [...content files in order: page-finder, layout, overlay, main], persistAcrossSessions: true, runAt: "document_idle"}])`, then `executeScript` into the tab and adds the origin to `storage.local.enabledOrigins`.
  - `am:disable-site {origin}`: unregisters, removes it from storage, and reloads the tab.
- Panel (this task): a header status line (helper ready / warming / unreachable / pairing hint), an API key field (`PUT /settings`), a deck dropdown (`GET /anki/decks`, saved per origin in `storage.local.decks[origin]`), and an "Enable on this site" / "Disable" toggle for the active tab's origin. The toggle calls `chrome.permissions.request({origins: [origin + "/*"]})` inside the click handler.

- [ ] **Step 1: Write failing tests** in `test/page-finder.test.js` (`node:test`, `require("../content/page-finder.js")`, fake img objects):
  - `realImageUrl` on `{src: "data:image/svg+xml,...", dataset: {src: "https://cdn/x/6.jpg"}, getAttribute: () => null}` → `"https://cdn/x/6.jpg"`.
  - `realImageUrl` on `{src: "data:...", dataset: {}, getAttribute: () => null}` → `null`.
  - `pageKey("https://cdn/a.jpg#x") === pageKey("https://cdn/a.jpg")`.
  - `isMangaImage(1132, 1600)` is true; `isMangaImage(300, 250)` is false; `isMangaImage(1, 1)` is false.
- [ ] **Step 2:** `cd extension && node --test`. Expected: FAIL.
- [ ] **Step 3:** Implement page-finder, the manifest, background routing for enable/disable, helper-client and the panel settings view.
- [ ] **Step 4:** `node --test` passes. Then a manual check:
  - Load unpacked in `chrome://extensions` with the helper running.
  - Click the action: the panel opens and shows "Helper ready".
  - Paste a key: it shows saved.
  - The deck list includes `manga mining`, and Anki now has the note type `Manga Mining (anki_manga)`.
  - Enable on the reference site: Chrome shows a permission prompt for that site only.
- [ ] **Step 5:** Commit: `feat(ext): skeleton, pairing, settings, site enabling`.

### Task 14: Text layer layout (pure)

**Files:** Create `extension/content/layout.js`, `extension/test/layout.test.js`

**Interfaces:**
- Produces `Layout = {splitTextIntoLines, layoutBubble}`:
  - `splitTextIntoLines(text: string, lineLengths: number[]) -> string[]`: splits `Array.from(text)` (code points) into `lineLengths.length` chunks. Chunk sizes are proportional to the lengths, using cumulative rounding so the sizes sum to the text length and no chunk is empty while chars remain. If there are more lines than chars, trailing lines get `""`.
  - `layoutBubble(bubble, natural: {w, h}, displayed: {w, h}) -> {box: {left, top, width, height}, vertical: bool, lines: [{text, left, top, width, height, fontSize, letterSpacing}]}`:
    - All values are in displayed px relative to the image's top-left, with scale `displayed.w / natural.w`.
    - Each line's rect is the axis-aligned bounds of its quad.
    - Line order: vertical lines by x descending, horizontal lines by y ascending.
    - Vertical: `fontSize = rect.width * 0.9`, `letterSpacing = max(0, (rect.height - n*fontSize) / n)`.
    - Horizontal: the same with width and height swapped.
    - `n` = the chunk's code-point count.

- [ ] **Step 1: Write failing tests:**
  - `splitTextIntoLines("これは坂の角度が", [100, 100])` → `["これは坂", "の角度が"]`.
  - `splitTextIntoLines("あいう", [300, 100])` → chunk lengths `[2, 1]`.
  - `splitTextIntoLines("あ", [10, 10, 10])` → `["あ", "", ""]`.
  - A vertical bubble with two line quads (x 900–930 and 860–890, y 100–300) at natural 1000 / displayed 500 → `lines[0].left === 450`, `lines[1].left === 430`, `box` scaled by 0.5, and `lines[0].fontSize === 13.5`.
  - The same bubble at displayed 1000 vs 500 → every rect value doubles (Review Focus 5).
- [ ] **Step 2:** `node --test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `node --test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ext): bubble text layout`.

### Task 15: Overlay + page pipeline on the reference site

**Files:**
- Create: `extension/content/overlay.js`, `extension/content/main.js`
- Modify: `extension/background.js`

**Interfaces:**
- Consumes: `PageFinder`, `Layout`, and the helper endpoints `/pages`, `/pages/{pid}/events`, `/prioritize`.
- Messages:
  - content → background `am:page {imageUrl}` → `{ok: true, page}` or `{ok: false, error, host?}`:
    - `error: "no_image_permission"` with `host` when `fetch(imageUrl)` from background lacks permission
    - also `"warming"`, `"helper_unreachable"`, `"bad_image"`
  - background then opens `/pages/{pid}/events` and forwards each `am:bubble-text {pageId, bubbleId, text}` to the sender tab via `chrome.tabs.sendMessage`.
  - content → background `am:prioritize {pageId, bubbleId}`.
  - content → background `am:missing-host {host}`: stored in `storage.session.missingHosts[tabId]`. The panel shows a button "Allow images from <host>" that requests `*://<host>/*` and then messages the tab `am:retry`.
- `overlay.js`:
  - `Overlay.attach(img, page) -> handle`: creates one layer root per image, a `position:absolute` div in `document.body`, positioned from `img.getBoundingClientRect() + scroll`, with `pointer-events:none`.
  - Per bubble: a `div.am-bubble` (`position:absolute; pointer-events:auto; color:transparent; writing-mode` per vertical; `line-height:1`; `white-space:nowrap`) containing `span.am-line` with `display:inline-block`.
  - After insertion, measure each span and apply `transform: translate(dx,dy)` so it lands on its `layoutBubble` line rect.
  - A bubble's text is set when `am:bubble-text` arrives. Until then it is empty.
  - `handle.update()` is called from a `ResizeObserver` on the img and on window `resize`.
  - Hovering a bubble with no text sends `am:prioritize`.
  - Clicking a bubble, or pressing `Alt+E` while hovering it, sends `am:select {pageId, bubbleId, pageUrl: location.href, pageTitle: document.title}`.
  - `Alt+V` toggles the class `am-show` on `<html>`, which makes the text visible (red on translucent white) for alignment checks.
- `main.js`:
  - An `IntersectionObserver` with `rootMargin: "150% 0px"` on every `img` passing `isMangaImage`.
  - A `MutationObserver` for added images and `src`/`data-src` changes.
  - A `Set` of processed `pageKey`s, so a lazy `src` swap to the same URL is skipped (Review Focus 1).
  - On `warming` or `helper_unreachable`, retry after 2s, 4s, 8s, then every 15s.

- [ ] **Step 1: Write the failing check.** This task is DOM- and Chrome-bound, so verification is manual and scripted. Add `extension/test/manual-checklist.md` with the steps below, all expected to fail before the implementation:
  1. Helper running, site enabled, open the reference chapter, `Alt+V`: red text sits on each bubble of pages 1–3 within about one character.
  2. Scroll to page 6 (the first lazy page): its overlay appears without the page being processed twice. The helper log shows one `POST /pages` per image.
  3. Shift-hover 「正確」 on page 6: the Yomitan popup shows 正確; adding with Yomitan gives a `{sentence}` of exactly 「これは坂の角度が正確に分かる道具なのです！」.
  4. Resize the window: the overlay follows.
  5. On a site that isn't enabled: no `.am-bubble` elements in the DOM.
- [ ] **Step 2:** Run the checklist. Expected: steps 1–4 fail (no overlay).
- [ ] **Step 3:** Implement overlay.js, main.js and the background `am:page` / SSE relay / missing-host flow.
- [ ] **Step 4:** Run the checklist plus `node --test`. Expected: all 5 manual steps OK; unit tests pass.
- [ ] **Step 5:** Commit: `feat(ext): invisible text layer with streaming OCR`.

### Task 16: Side panel: explanation and cards

**Files:** Modify `extension/panel/panel.html`, `panel.css`, `panel.js`, `extension/background.js`

**Interfaces:**
- Consumes:
  - `am:select` (background stores it in `storage.session.lastSelection` and broadcasts `am:selected`)
  - helper `GET /pages/{pid}/bubbles/{bid}`, `POST /explain`, `POST /cards`, `POST /anki/refresh`
- Behaviour:
  - On panel open and on deck change: `POST /anki/refresh`.
  - On `am:selected`:
    1. Push a history entry at the top.
    2. Fetch `/bubbles/{bid}` and render `ruby_html` immediately.
    3. Then call `/explain` and render the translation, "Why it's written this way" notes and "Worth a card" rows.
    - `in_deck === true` → greyed out, button `✓ in deck`, disabled.
    - `"+"` → `POST /cards` with the row's `word`, `reading`, `meaning` and the selection's `pageUrl`/`pageTitle`. Success → the button becomes `✓ added`. 409 → `✓ in deck`.
  - Visual: mockup A from the spec §4.4 (light panel, uppercase section labels, red `rt`, accent-bordered note cards, green "+" buttons).
  - Error copy (exact):

    | error | message |
    |---|---|
    | `helper_unreachable` | `Helper not running — start it with: anki-manga-helper` |
    | `warming` | `Loading OCR models…` |
    | `no_api_key` | `Add your DeepSeek API key in Settings to get explanations.` |
    | `auth` | `DeepSeek rejected the API key — check it in Settings.` |
    | `bad_response` / 502 | `Explanation failed — click the bubble again to retry.` |
    | `anki: "unreachable"` | `Anki isn't running — open Anki with AnkiConnect to add cards.` |
    | `page_expired` | `This page is no longer cached — scroll back to it and try again.` |

- [ ] **Step 1: Write the failing check:** append to `manual-checklist.md`:
  6. Click the 「これは坂の…」 bubble: furigana appears before the explanation; then the translation, 2–5 notes and 2–4 suggestions.
  7. Click the same bubble again: it answers instantly, and the helper log shows no DeepSeek call.
  8. "+" on a suggestion: a `Manga Mining (anki_manga)` note appears in `manga mining` with the panel picture, bold word and source link; the row shows `✓ added`.
  9. Quit Anki and click a new bubble: the explanation still shows, plus the Anki message.
  10. Remove the API key: the `no_api_key` message shows.
- [ ] **Step 2:** Run steps 6–10. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run steps 1–10. Expected: all OK.
- [ ] **Step 5:** Commit: `feat(ext): explanation panel and one-click cards`.

### Task 17: Screenshot fallback for unfetchable or canvas pages

**Files:** Modify `extension/background.js`, `extension/content/main.js`, `extension/content/page-finder.js`, `extension/test/page-finder.test.js`

**Interfaces:**
- `PageFinder.isMangaElement(el)`: true for an `<img>` passing `isMangaImage`, or a `<canvas>` with `min(w,h) >= 400 && max(w,h) >= 600`.
- content → background `am:capture {rect: {x, y, width, height}, dpr}`. Used for canvases, and for images whose `am:page` returned anything other than `ok`, `warming`, `helper_unreachable` or `no_image_permission`. Sent only when the element is ≥ 90% in the viewport.
  1. Background runs `chrome.tabs.captureVisibleTab(windowId, {format: "png"})`.
  2. It crops `rect × dpr` with `OffscreenCanvas`.
  3. It posts the result to `/pages` and replies like `am:page`.
- The overlay for captured pages uses natural size = crop px and displayed size = the element rect.

- [ ] **Step 1: Write failing tests:** `isMangaElement` on fake `{tagName: "CANVAS", width: 800, height: 1200}` is true; on a `{tagName: "CANVAS", width: 300, height: 150}` it is false.
- [ ] **Step 2:** `node --test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `node --test` passes. Manual check: add `manual-checklist.md` step 11. On a local test page that draws one of the sample JPGs into a `<canvas>` (served from the git-ignored samples folder, enabled like a site), `Alt+V` shows aligned text.
- [ ] **Step 5:** Commit: `feat(ext): screenshot fallback for canvas pages`.

### Task 18: README and install

**Files:** Create `README.md`

Contents (exact sections):
1. **What it does:** a GIF placeholder line, and the 3-sentence pitch.
2. **Install:**
   1. `uv tool install "git+https://github.com/<owner>/anki_manga#subdirectory=helper"` (pipx alternative), then run `anki-manga-helper`.
   2. Load the extension unpacked from `extension/` (release zip later).
   3. Anki + AnkiConnect.
   4. Yomitan for hover lookup.
   5. Open the panel, paste the DeepSeek key, pick a deck.
3. **Using it:** Shift-hover vs click; `Alt+V`; enabling per site, and the image-host button.
4. **Optional: point Yomitan at the new note type:** field mapping Word=`{expression}`, Reading=`{reading}`, Meaning=`{glossary-brief}`, Sentence=`{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}`.
5. **Troubleshooting:** `--reset-pairing`, warming time, where the config and cache live.
6. **Privacy:** what is sent to DeepSeek (only the text of bubbles you click); the key is stored locally.
7. **License:** GPL-3.0, with credits to mokuro, manga-ocr, comic-text-detector.

- [ ] **Step 1:** Write the README.
- [ ] **Step 2:** Verify by following Install steps 1–5 on a clean `ANKI_MANGA_HOME` and with the extension removed and re-added. Expected: the panel reaches "Helper ready" with no other steps.
- [ ] **Step 3:** Commit: `docs: README with install and Yomitan mapping`.

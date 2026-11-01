# anki_manga: AI-assisted manga reader for Anki mining — Design

Date: 2026-11-01
Status: draft for approval

## 1. Intent

The owner is learning Japanese by reading manga, mostly on websites in Chrome. Their current mining workflow is:

1. screenshot a bubble
2. run `manga_ocr` in a terminal (it watches the clipboard)
3. paste the text into Yomitan search
4. click "+" to make an Anki card

It works, but it breaks the reading flow.

This project removes the screenshot / terminal / paste steps entirely and adds what Yomitan can't do: explain **why** a sentence is written the way it is (grammar and structure), not just translate words.

It will be published on GitHub for friends: easy install, bring-your-own DeepSeek key, no secrets in the repo.

### What success looks like (v1)
The user switches the tool on for a manga site, then:
- **Shift-hovers** any bubble and gets the normal Yomitan popup (word lookup, "+" to add a card).
- **Clicks** a bubble to see a side panel with:
  - the bubble text with furigana
  - a translation
  - a grammar explanation
  - words worth learning, each with a one-click "+" that makes a rich card (sentence + panel picture)

No screenshots, no terminal, no pasting.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**
- Bubble text from web manga becomes hoverable by Yomitan without any manual step.
- A side panel explains a clicked bubble: furigana, translation, grammar explanation, card suggestions.
- One-click card creation into a dedicated, richer note type that the tool creates itself.
- Suggestions never propose words already in the target deck.
- Minimal DeepSeek token use: one short call per clicked bubble, results cached forever, never repeated for the same bubble.
- Easy for friends to install: few steps, bring-your-own key, macOS + Chrome.

**Non-goals (v1)**
- No replacement for Yomitan's word lookup. Yomitan is required in v1 for hover lookup.
- No detection of loose text outside bubbles (signs, sound effects). Bubbles only.
- No Windows/Linux packaging work. It should not be needlessly macOS-specific, but only macOS is tested.
- No mobile.
- No preprocessing of downloaded volumes (mokuro-style offline files). Live web pages only.

**Anti-goals (would make it a failure even if it "works")**
- The DeepSeek call fires on hover, or repeats for a bubble it already explained. That burns credits.
- Hover feels laggy, or the text layer interferes with normal page use (scrolling, clicking site buttons) on sites where it is switched off.
- Friends have to hand-configure Anki note types or edit config files to get started.
- Any API key, personal Anki data, Yomitan settings export or copyrighted manga page ends up in the repo.

## 3. Roadmap (decided with the owner)

| Version | Content |
|---|---|
| **v1** | Text layer for Yomitan hover + side panel (furigana, translation, grammar explanation, card suggestions, "+", in-deck check) + own note type |
| **v2** | Explanations adapted to the learner's level (e.g. JLPT N4), and a follow-up question box under the explanation ("why not を here?") |
| **v3** | "Make this chapter a lesson": a pre-reading list of frequent unknown words for the chapter (checked against Anki), plus an end-of-session recap of the grammar met, with grammar cards built from the real bubbles |
| **v4** | Suggest words the user keeps looking up but never added; other ideas |
| later (unscheduled) | Standalone mode without Yomitan: helper does word segmentation (fugashi) + local JMdict lookup, panel shows a clickable word list. The owner wants friends eventually not to need Yomitan, but **v1 is with Yomitan** |

Considered and **not planned** (the owner did not pick them):
- LLM correction of OCR errors
- casual → standard form rewriting (見りゃ → 見れば)
- sending the previous bubbles as context

v1 should not quietly include them.

## 4. Architecture (v1)

Two pieces:

```
┌────────────────────── Chrome ──────────────────────┐
│ content script (per enabled site)                   │
│   finds manga <img>/<canvas>, draws invisible text  │
│   layer, handles bubble click                       │
│ background service worker                           │
│   fetches page images, talks to helper              │
│ side panel (chrome.sidePanel)                       │
│   furigana / translation / explanation / cards      │
└──────────────┬──────────────────────────────────────┘
               │ HTTP on 127.0.0.1 only
┌──────────────▼──────────────────────────────────────┐
│ local Python helper                                  │
│   comic-text-detector + manga_ocr (MPS on Apple GPU) │
│   furigana (fugashi + unidic-lite)                   │
│   DeepSeek calls, SQLite cache                       │
│   AnkiConnect client (in-deck checks, add note,      │
│   create note type)                                  │
└──────────────────────────────────────────────────────┘
```

**Why a helper.** manga_ocr and the detector are PyTorch models and cannot run inside a Chrome extension. The helper is the single place for models, the cache, the API key and Anki access.

### 4.1 Bubble detection and OCR (decided, measured)

- Use the same models mokuro uses: **comic-text-detector** (`comictextdetector.pt`) for bubbles and **manga_ocr** (`kha-white/manga-ocr-base`) for text. Call them directly from our helper; don't go through mokuro's volume pipeline. mokuro's `MangaPageOcr` is good reference code.
- **OCR once per detected bubble**, on the bubble crop, not per line as mokuro does. A spike on the owner's pages showed equal accuracy and about 35% less time.
- **Order of work per page:**
  1. detect all bubbles (about 0.5s)
  2. send the bubble boxes to the page right away
  3. OCR bubbles in reading order (right→left, top→bottom), streaming each result as it is ready
  4. a bubble the user hovers or clicks jumps to the front of the queue
- **Merge overlapping or duplicate boxes.** The detector returned 「まじか！」 twice on one test page.
- **Prefetch:**
  - Scroll readers: a page is processed when it comes near the viewport.
  - One-page-per-URL readers: process on load. A changed `src` counts as a new page.
  - Only images above a size threshold count as manga pages, so icons and ads are skipped.
- **Cache key:** a hash of the image bytes, so a page is never processed twice, even across sessions.

**Spike results** (owner's M1, 16 GB, two real pages with 11 and 17 bubbles, models warm):

| step | M1 GPU (MPS) | CPU |
|---|---|---|
| model load (once at helper start) | 3–11s | about 3s |
| detect bubbles on a page | 0.5s | 1.0s |
| OCR per bubble | about 0.15s | about 0.3s |
| full page, per-bubble OCR | 2.3–2.8s | 4.3–5.6s |
| full page, mokuro per-line OCR | 3.2–3.8s | 6–7s |

Accuracy: 26/28 bubbles correct. Misses were 「いやいやいや」 (slightly garbled) and a handwritten 「さー？」 (not detected).

### 4.2 Getting the image (decided)

- The background worker fetches the image's `src` URL itself. Extension host permissions bypass page CORS.
- Fallback for canvas-rendered or un-fetchable pages: `chrome.tabs.captureVisibleTab`, cropped to the element's rectangle. The text layer is then mapped back to that rectangle.
- **Activation is per site.** The user switches it on for a site, and the choice is remembered. The extension requests that site's host permission at that moment (optional host permissions), so the install doesn't ask for "read all sites".
- **The images often live on a different host than the reader page.** Enabling a site must also obtain permission for the image host(s) it uses. For example, request it when the first manga image is found, or request both up front.

**Reference site (the v1 acceptance target).** The owner reads mostly on a scroll-style raw-manga reader. The URL was given in the design conversation and is deliberately not named in this public repo. Structure, checked 2026-11-01:
- One HTML page per chapter, with every page as a plain `<img>` (no canvas).
- The first 3 images have real `src`. The rest are **lazy**: `src` is a 1×1 SVG data-URI placeholder, the real URL sits in `data-src`, and the class is `lazy`. The site swaps them in as you scroll.
  - The extension can read `data-src` directly to prefetch pages **before** the site loads them. It must also handle the later `src` swap without processing a page twice (key by image URL/bytes).
- Images are served from a separate CDN host:
  - plain `.jpg` files, about 1132×1600, about 750 KB
  - **downloadable with no Referer or cookies**
  - no CORS headers, so the fetch must come from the extension background with host permission, not from the page
- Both spike pages came from this site, byte-identical.

**v1 is done** when, on that site with the owner's setup:
- Shift-hover on bubbles gives correctly aligned Yomitan lookups.
- Clicking a bubble fills the panel.
- "+" creates a card with the panel picture.

Other layouts (one-page readers, canvas) are supported best-effort through the same code paths.

### 4.3 Text layer for Yomitan (decided; constraints verified in Yomitan source)

- **One absolutely-positioned element per bubble**, holding the **whole bubble text as a single run**.
  - Yomitan's sentence extraction (default `terminationCharacterMode: "custom"`, `layoutAwareScan: true`) stops at line breaks and treats absolutely-positioned elements as line breaks.
  - So one element per bubble gives `{sentence}` = exactly that bubble.
  - One element per line would chop sentences.
  - No block-level children inside a bubble element.
- **Text must be invisible but still scannable.** Use `color: transparent`, and keep the text selectable. **Never** use `opacity: 0`, `visibility: hidden` or `font-size: 0`, because Yomitan skips those (`DOMTextScanner.isStyleVisible`).
- Use `writing-mode: vertical-rl` for vertical bubbles. Size and space the glyphs to match the detected **line positions** (the detector returns per-line coordinates), so the character under the cursor is the one printed there.
  - The throwaway spike just poured text into the box. The owner found that "scuffed", and the cause was misalignment. Fixing alignment is a v1 requirement.
- Furigana is **not** drawn over the page in v1. It lives in the panel.
- The layer must not block site interaction:
  - pointer events pass through except over bubbles
  - nothing is injected on sites that aren't enabled
  - a toggle key shows or hides the layer (useful for debugging alignment)

### 4.4 Side panel (decided; layout approved from mockup "A")

- Chrome's built-in side panel (`chrome.sidePanel`) on the right. It stays open while reading.
- **Trigger:** clicking a bubble (or pressing a hotkey while hovering it) sends that bubble to the panel. **Hover never triggers DeepSeek.** The click must not break Shift-hover for Yomitan.
- **Panel contents, top to bottom:**
  1. **Bubble text with furigana**: instant, local (fugashi + unidic-lite, which manga_ocr already installs). No LLM.
  2. **Translation.**
  3. **"Why it's written this way"**: 2–5 short grammar or structure notes. Example from the mockup, for 「これは坂の角度が正確に分かる道具なのです！」:
     - 分かる takes が, not を
     - 正確に is a na-adjective + に used as an adverb
     - the whole clause before 道具 describes it
     - what なのです adds
  4. **Worth a card**: 2–4 words or phrases with reading + short meaning and a "+". Items already in the target deck appear greyed out as "✓ in deck".
- Items 2–4 come from **one DeepSeek call** with a JSON response. They appear when it arrives; the furigana is shown before that.
- The panel keeps a scrollable history of the bubbles clicked this session.
- **Clear status messages** when the helper isn't running, Anki/AnkiConnect is unreachable, or the API key is missing or invalid. Never fail silently.
- Explanations are in **English**.
- Panel settings: DeepSeek API key, target deck (per site), helper status.
- Visual reference: the approved mockup A, a light panel with section labels, furigana in red `rt`, grammar notes as cards with an accent left border, and green "+" buttons. The mockup is in `.superpowers/brainstorm/` locally (git-ignored).

### 4.5 DeepSeek usage (decided: minimal tokens)

- Called only on an explicit click or hotkey, once per unique bubble text.
- **Cached in the helper's SQLite**, keyed by normalized bubble text (+ prompt version), so repeats cost zero, even across sessions and pages.
- A short, **fixed** system prompt placed first, so DeepSeek's automatic prefix caching applies. JSON output mode. Tight `max_tokens`.
- The in-deck word list is **not** sent in full. Filter on our side instead:
  1. DeepSeek returns candidates.
  2. The helper drops or greys out ones already in the deck (by dictionary form).
  3. Optional, as the builder sees fit: send a small list of the bubble's own words that are already known, so the model doesn't waste a slot on them.
- Model: DeepSeek's current general chat model (`deepseek-chat`). The model name is a config value.

### 4.6 Anki integration (decided)

- Via **AnkiConnect** (`http://127.0.0.1:8765`).
- **The tool creates its own note type** on first run if it's missing (`createModel`), working name **"Manga Mining (anki_manga)"**. Fields:

| Field | Content |
|---|---|
| Word | dictionary form |
| Reading | kana |
| Meaning | short English gloss (from DeepSeek's suggestion) |
| Sentence | the bubble text with the target word in **bold** |
| SentenceFurigana | the bubble with `<ruby>` |
| SentenceTranslation | |
| Explanation | the grammar notes for that bubble (short) |
| Picture | crop of the **comic panel the bubble is in** (the owner explicitly wants the panel, not just the bubble) |
| Source | page URL + site title |

  Card template: front = Word + Sentence; back = everything else. Keep it clean and readable; exact styling is the builder's call.
- **Target deck:** chosen in the panel, remembered per site. The owner's current mining deck is `manga mining`.
- **In-deck check (designer's call, works for friends without configuration):**
  - **What counts as known:** a word is "in deck" if any note in the **target deck** has it either:
    - in the `Word` field of our note type, or
    - in the **first field** of any other note type, with HTML and furigana markup stripped. This covers the owner's Basic `Front` and typical Yomitan note types.
  - **Matching:** compare by dictionary form.
    - A kana-only note entry also matches a kanji word when their readings are equal (わかる ↔ 分かる).
    - A kanji entry never matches on reading alone, to avoid false matches between homophones.
  - **Scope:** only the target deck counts. The owner asked for per-deck behaviour, so decks like Kaishi 1.5k don't count in v1. "Also count these decks as known" is a possible later setting.
  - Cache the deck's word list in the helper and refresh it on panel open and after each add.
- **Adding a card** via `addNote` with media (the Picture) passed through AnkiConnect's `picture` parameter.
- **Coexistence with Yomitan:** Yomitan's own "+" keeps working as it is configured. The README documents how to point Yomitan at the new note type for consistency (field-marker mapping such as Word=`{expression}`, Reading=`{reading}`, Meaning=`{glossary-brief}`, Sentence=`{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}`). This is optional.

The owner's current Anki state, for reference (read via AnkiConnect, 2026-11-01):
- Yomitan adds Basic notes to `manga mining` (Front=`{expression}`, Back=`{reading}<br>{glossary}<br>{sentence}`), with duplicate scope set to collection. The deck holds 1 note.
- The dictionary is Jitendex.
- The owner also has a Kaishi 1.5k deck and note type.

### 4.7 Finding the comic panel for the Picture field (builder's leeway)

The detector finds text, not panels. Use a simple OpenCV approach: find panel borders (large rectangular contours or gutter whitespace), then take the panel containing the bubble's centre. If that fails, fall back to the bubble box expanded by a margin, clamped to the page. Resize and compress the crop (e.g. WebP or JPEG, about 600px on the long side).

## 5. Install and setup (goal: as few steps as possible)

**For a friend:**
1. Install the Chrome extension (unpacked from the GitHub release at first; Chrome Web Store later is a nice-to-have).
2. Install and start the helper with one command (e.g. `uv tool install …` / `pipx install …`, then `anki-manga-helper`). The first run downloads the models (several hundred MB of model weights plus PyTorch, about 1.3 GB environment) and says so.
3. Have Anki + AnkiConnect running. Yomitan is installed for hover lookup.
4. Open the panel, paste a DeepSeek API key, pick a deck. The note type is created automatically.

**Rules:**
- The API key lives only in the helper's user config directory (macOS: `~/Library/Application Support/anki_manga/`), set via the panel. It never goes in the repo, the extension bundle or logs.
- The helper listens on **127.0.0.1 only**.
- *Threat model (designer's call):* the protection is against **web pages**, not other local programs. A local process could already read the key from the config file, so a pairing step would add friction for no real gain.
- Concretely, the helper:
  - rejects requests whose `Origin` is not a `chrome-extension://` origin
  - rejects any `Host` other than `127.0.0.1`/`localhost` with the right port (DNS-rebinding guard)
  - requires a random token the helper generates on first run and hands to the extension on its first successful connection (trust on first use)
- No user-visible pairing step. The extension ID does not need to be pinned.
- Starting the helper automatically at login is a nice-to-have, not v1.

## 6. Repo hygiene

- `.gitignore`: the owner's sample pages (`*.jpg`/`*.png` in the root), `yomitan-settings-*.json`, `.superpowers/`, Python venvs, caches, model files, `.env`.
- No manga images in the repo. Test fixtures must be self-made or openly licensed.
- **License: GPL-3.0** (the owner agreed).
  - This lets the helper **depend on `mokuro` as a library** (GPL-3.0). The `comic_text_detector` package ships inside the mokuro wheel and isn't published on its own.
  - Use mokuro's `TextDetector`, model cache/download and `MangaPageOcr` code directly, rather than reimplementing them.
  - manga_ocr is Apache-2.0, which is compatible.
  - Model weights are downloaded at runtime, not bundled.

## 7. Left to the builder

- Helper web framework and API shape (HTTP + SSE or WebSocket for streaming per-bubble results).
- Extension build tooling (plain JS or TypeScript + a bundler), Manifest V3 details.
- Exact glyph-fitting algorithm for the text layer, as long as alignment is good on the sample pages.
- Panel-finding algorithm (4.7).
- The DeepSeek prompt wording and JSON schema, within the token goals.
- The size threshold for "this image is a manga page".
- Test strategy. The spike pages can be used locally for manual checks but must not be committed.

## 8. Open risks

- **Sites that scramble images** (tile-shuffled canvas readers) only work through the screenshot fallback. Accept degraded support.
- **Cold start:** model load takes 3–11s on first helper start. The panel should show "warming up".
- **Handwritten or stylised text** may be missed by the detector. That's accepted for v1, since loose text is out of scope.

# anki_manga

Read Japanese manga in Chrome and turn speech bubbles into Anki cards with almost no friction.

<!-- GIF: hover a bubble with Yomitan, click it, add a card from the panel -->

- **Hover** any speech bubble with Yomitan (hold Shift). The bubble's text is OCR'd locally and laid invisibly over the image, so Yomitan works on manga pages, and the card's sentence is exactly that bubble.
- **Click** a bubble to open the side panel: the line with furigana, a translation, a short explanation of *why it's written that way*, and the words worth learning.
- **"+"** adds a rich card: word, reading, meaning, the bubble sentence with the word in bold, furigana, translation, grammar notes, a picture of the comic panel, and the source link. Words you already have in the deck are greyed out.

OCR runs on your machine ([manga-ocr](https://github.com/kha-white/manga-ocr) and comic-text-detector, through [mokuro](https://github.com/kha-white/mokuro)). Explanations use your own DeepSeek API key. Only the text of the bubbles you click is sent, and every answer is cached, so the same bubble is never paid for twice.

## Install

You need macOS (Apple Silicon is fastest; other systems may work), Chrome, [Anki](https://apps.ankiweb.net/) with [AnkiConnect](https://ankiweb.net/shared/info/2055492159), and [uv](https://docs.astral.sh/uv/) (or pipx).

1. **Install and start the helper** (the local OCR service):

   ```sh
   uv tool install "git+https://github.com/<owner>/anki_manga#subdirectory=helper"
   anki-manga-helper
   ```

   The first start downloads the OCR models: about 1 GB with PyTorch, a few minutes. After that it starts in a few seconds and prints `ready`. Keep it running while you read. With pipx: `pipx install "git+https://github.com/<owner>/anki_manga#subdirectory=helper"`.

2. **Load the extension:** download this repo (or a release zip). Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.

3. **Open Anki** with AnkiConnect installed.

4. **Install [Yomitan](https://yomitan.wiki/)** with a dictionary (for example Jitendex) for hover lookups.

5. **Click the anki_manga toolbar icon** to open the side panel. Under **Settings**, paste your [DeepSeek API key](https://platform.deepseek.com/api_keys) and pick a deck. The note type **Manga Mining (anki_manga)** is created in Anki automatically.

## Using it

- Open a manga reader site and click **Enable on this site** in the panel. Chrome asks for access to that site only.
- If the panel then shows **Allow images from <host>**, click it once. Many readers load images from a separate server.
- Pages are processed as they come near the screen, so by the time you reach a page its bubbles are usually ready.
- **Shift-hover** for Yomitan. **Click** a bubble, or press **Alt+E** while hovering it, to explain it in the panel.
- **Alt+V** shows or hides the hidden text layer. It's useful to check alignment.
- Readers that draw pages on a `<canvas>` work through a screenshot fallback while the page is fully on screen.

## Optional: make Yomitan use the same note type

Yomitan's own "+" button keeps working as you configured it. To give its cards the same layout, go to Yomitan Settings → Anki → Card format, pick the **Manga Mining (anki_manga)** model, and map:

| Field | Value |
|---|---|
| Word | `{expression}` |
| Reading | `{reading}` |
| Meaning | `{glossary-brief}` |
| Sentence | `{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}` |

Leave the other fields empty. The panel fills them when you add from there.

## Troubleshooting

- **"Helper not running"**: start `anki-manga-helper` in a terminal.
- **"Loading OCR models…"**: the helper is still starting (3–10 s, longer on the first run).
- **"This helper is paired with another install"**: you reinstalled the extension. Run `anki-manga-helper --reset-pairing`, restart the helper, and reopen the panel.
- **"Anki isn't running"**: open Anki. Explanations still work without it, but cards can't be added.
- **Where things live** (macOS): settings and the API key are in `~/Library/Application Support/anki_manga/config.json` (readable only by you). The cache (OCR results, explanations, recent page images) is in `~/Library/Caches/anki_manga/`. Set `ANKI_MANGA_HOME` to move both.

## Privacy

- Page images are processed only on your machine, by the helper on `127.0.0.1`. It refuses requests from web pages.
- DeepSeek only receives the text of a bubble you click, once, and then never again thanks to the cache.
- Your API key is stored locally in the helper's config file and never in the extension or this repository.

## Development

```sh
cd helper && uv sync --extra dev && uv run pytest -m "not models"   # fast tests
ANKI_MANGA_SAMPLES=/path/to/pages uv run pytest -m models             # real-model tests
cd extension && node --test                                           # content-script logic
```

Manual browser checks are in `extension/test/manual-checklist.md`. Design and plan: `docs/superpowers/`.

## License

GPL-3.0-or-later. Built on [mokuro](https://github.com/kha-white/mokuro) (GPL-3.0), [manga-ocr](https://github.com/kha-white/manga-ocr) (Apache-2.0) and [comic-text-detector](https://github.com/dmMaze/comic-text-detector), with model weights downloaded at runtime.

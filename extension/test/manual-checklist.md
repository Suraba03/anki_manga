# Manual checklist (real Chrome, helper running, extension loaded unpacked)

Setup: `cd helper && uv run anki-manga-helper` (wait for `ready`), Anki + AnkiConnect open, Yomitan installed.
Reference site: the owner's scroll-style raw reader (see design conversation; not named in the repo).

## Setup (Task 13)
- [ ] 0a. `chrome://extensions` → Developer mode → Load unpacked → `extension/`. Click the toolbar icon: the side panel opens and shows **Helper ready**.
- [ ] 0b. Settings → paste a DeepSeek key → Save → "Key saved."
- [ ] 0c. The deck list includes `manga mining`. Anki now has the note type `Manga Mining (anki_manga)`.
- [ ] 0d. Click "Enable on this site": Chrome asks for **that site only**. If the panel then shows "Allow images from <host>", click it once.

## Text layer (Task 15)
- [ ] 1. Open a chapter and press `Alt+V`: red text sits on each bubble of pages 1–3, within about one character.
- [ ] 2. Scroll to the first lazy page: its overlay appears. The helper processes each image once (no second `POST /pages` for the same image after the `src` swap).
- [ ] 3. Shift-hover 「正確」 on the 「これは坂の角度が正確に分かる道具なのです！」 page: the Yomitan popup shows 正確. Adding it with Yomitan's own "+" gives a `{sentence}` of exactly that bubble.
- [ ] 4. Resize the window: the overlay follows the images.
- [ ] 5. On a site that isn't enabled: no `.am-bubble` elements in the DOM.

## Panel (Task 16)
- [ ] 6. Click the 「これは坂の…」 bubble: furigana appears first, then the translation, 2–5 notes and 2–4 suggestions.
- [ ] 7. Click the same bubble again: it answers instantly (`cached`), with no DeepSeek call.
- [ ] 8. "+" on a suggestion: a `Manga Mining (anki_manga)` note appears in `manga mining`, with the panel picture, the bold word and the source link. The row shows `✓ added`.
- [ ] 9. Quit Anki and click a new bubble: the explanation still shows, plus "Anki isn't running…".
- [ ] 10. With no API key saved: clicking a bubble shows "Add your DeepSeek API key in Settings…".

## Fallback (Task 17)
- [ ] 11. A page that draws a manga page into a `<canvas>` (enabled like a site): `Alt+V` shows aligned text.

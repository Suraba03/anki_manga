# Manual checklist (real Chrome, extension loaded unpacked)

Setup: Anki + AnkiConnect open, Yomitan installed. No helper is needed any more.
Reference site: the owner's scroll-style raw reader (see design conversation; not named in the repo).

## First run
- [ ] 0a. `chrome://extensions` → Developer mode → Load unpacked → `extension/`. Click the toolbar icon: the side panel opens. The top status goes `Downloading models… N%` → `Loading models…` → `Ready (WebGPU)` (or `Ready (CPU)`).
- [ ] 0b. Block the network (or point the models at a dead URL) and reload the extension: the status turns red (`Model download failed — check your connection.`) with a **Retry** button; Retry starts the download again.
- [ ] 0c. The deck list in Settings includes `manga mining`. Anki shows a permission prompt for the extension the first time (accept it). Declining shows the one-line hint about the AnkiConnect permission prompt / `webCorsOriginList`.
- [ ] 0d. Click "Enable on this site": Chrome asks for **that site only**. If the panel then shows "Allow images from <host>", click it once.

## Text layer
- [ ] 1. Open a chapter and press `Alt+V`: red text sits on each bubble of pages 1–3, within about one character.
- [ ] 2. Scroll to the first lazy page: its overlay appears. A page is processed once (no second pass for the same image after the `src` swap).
- [ ] 3. Shift-hover 「正確」 on the 「これは坂の角度が正確に分かる道具なのです！」 page: the Yomitan popup shows 正確. Adding it with Yomitan's own "+" gives a `{sentence}` of exactly that bubble.
- [ ] 4. Resize the window: the overlay follows the images.
- [ ] 5. On a site that isn't enabled: no `.am-bubble` elements in the DOM.
- [ ] 5b. Hovering a bubble never calls an explanation (the panel stays unchanged; no network request to the free server or the provider).

## Free tier (no key)
- [ ] 6. Click the 「これは坂の…」 bubble: furigana appears first, then the translation, 2–5 notes and 2–4 suggestions. Settings → Explanations shows `Free` selected and `N left today`.
- [ ] 7. Click the same bubble again: it answers instantly (cached) and the count does not drop.
- [ ] 8. Free server unavailable (offline, or before it is deployed): `The free explanation service is unavailable right now. Try again later or add your own API key.` plus an "Add your own API key" button that opens Settings with the own-key form.
- [ ] 9. Daily limit used up: `Today's free explanations are used up — they reset tomorrow. Add your own API key to keep going.` Monthly cap: `Free explanations are used up for this month. Add your own API key to keep going.`
- [ ] 10. A bubble with no recognized text shows `No text was recognized in this bubble.`

## Own key
- [ ] 11. Settings → "Use my own API key", provider DeepSeek, paste a key → Save → "Saved." Click a new bubble: the explanation arrives. A wrong key: `DeepSeek rejected the API key — check it in Settings.`
- [ ] 12. Provider Custom with a base URL (e.g. an OpenAI-compatible host): Save asks Chrome for that host's permission (a prompt on click). Declining does not save; accepting does, and explanations work.
- [ ] 13. Own key mode with no key: `Add your DeepSeek API key in Settings to get explanations.`

## Dictionary
- [ ] 14. Click a word of the sentence in the panel (not the bubble): "Looking up…" (the first time the dictionary downloads, about 11 MB), then up to 5 entries with reading, part of speech and glosses; a conjugated 食べ finds 食べる. Click the word again: the card closes. Punctuation is not clickable.
- [ ] 15. A name or odd word with no entry: `No dictionary entry for …`.
- [ ] 16. After 3 idle minutes the next lookup still works (the dictionary is reloaded from the cache without a download).

## Cards
- [ ] 17. "+" on a suggestion: a `Manga Mining (anki_manga)` note appears in `manga mining`, with the panel picture, the bold word and the source link. The row shows `✓ added`.
- [ ] 18. "+" on a dictionary entry: same, with the dictionary gloss as Meaning, plus the translation and notes if the explanation had arrived.
- [ ] 19. Words already in the deck are greyed with `✓ in deck`; adding the same word again also ends as `✓ in deck`.
- [ ] 20. Quit Anki and click a new bubble: the explanation still shows, plus "Anki isn't running…".

## Performance mode
- [ ] 21. Settings → Text recognition: **Prefetch** reads every bubble of a newly opened page ahead of time; **On demand** reads a bubble only when hovered (dashed outline until its text arrives); **Auto** picks one by the speed measured on this machine.

## Delete data
- [ ] 22. Settings → "Delete downloaded models and caches" asks to confirm, then the status shows `Models deleted.` with **Download again**; clicking it downloads the models again. Explanations for earlier bubbles are fetched afresh.

## About
- [ ] 23. Settings → About lists comic-text-detector (GPL-3.0), manga-ocr (Apache-2.0), JMdict (CC BY-SA 4.0), kuromoji (Apache-2.0); the privacy link opens https://suraba03.github.io/anki_manga/privacy.

## Fallback (Task 17)
- [ ] 24. A page that draws a manga page into a `<canvas>` (enabled like a site): `Alt+V` shows aligned text.

## Status (after v1 review)
- [ ] 25. Reload the extension (↻) and then the manga tab: the site still works; there are no duplicate layers.
- [ ] 26. Each page shows a corner badge: `⏳ finding bubbles…` → `⏳ 4/11` → `✓ 11`, which fades. While the models are still downloading it shows `⏳ downloading models…`.
- [ ] 27. Hovering a bubble that hasn't been recognized yet shows a dashed outline.
- [ ] 28. The panel shows `Pages: N ready · M recognizing` under the site name.

# Manga OCR & Mining for Anki

Read Japanese manga in Chrome and turn speech bubbles into Anki cards with almost no friction.

<!-- GIF: hover a bubble with Yomitan, click it, add a card from the panel -->

- **Hover** any speech bubble with [Yomitan](https://yomitan.wiki/) (hold Shift). The bubble's text is read in your browser and laid invisibly over the image, so Yomitan works on manga pages, and the card's sentence is exactly that bubble.
- **Click** a bubble to open the side panel. It shows the line with furigana, a dictionary entry for any word you click, a translation, a short explanation of *why it's written that way*, and the words worth learning.
- **"+"** adds a rich card to Anki: the word, its reading and meaning, the bubble sentence with the word in bold, furigana, translation, grammar notes, a picture of the comic panel, and a link back to the page. Words already in your deck are greyed out.

There is nothing else to install: no helper program, no Python, no Terminal. Text recognition (OCR) runs on your computer with [manga-ocr](https://github.com/kha-white/manga-ocr) and comic-text-detector, and **the extension never uploads page images**. Explanations use an online service (the project's free server, or your own provider with your key) and receive the text of a bubble you click, unless you set Explanations to **Off**; then no bubble text is sent.

## What's new in 0.3.0

- **Faster start.** The first download shows megabytes and time left, a welcome tab follows it, and after a browser restart the extension is ready in about a second.
- **Works on more sites.** Images are loaded the way the page loads them, tall pages are read from screenshots, and thumbnails no longer get badges.
- **A clear message** when an explanation isn't available for a line.
- **A green "✓ added"** once a card is in Anki.

---

## Contents

1. [What you need](#what-you-need)
2. [Install](#install)
3. [Anki and AnkiConnect](#anki-and-ankiconnect)
4. [First run](#first-run)
5. [Reading and mining](#reading-and-mining)
6. [Explanations: free tier or your own key](#explanations-free-tier-or-your-own-key)
7. [Dictionary](#dictionary)
8. [Status badges](#status-badges)
9. [Yomitan (optional)](#yomitan-optional)
10. [Troubleshooting](#troubleshooting)
11. [Privacy](#privacy)
12. [Development](#development)
13. [Licences](#licences)

---

## What you need

- **Google Chrome** 116 or newer (other Chromium browsers may work). A GPU with WebGPU makes text recognition faster; without it the extension falls back to the CPU automatically.
- About **400 MB of disk space** for the models and the dictionary, downloaded after installation (the dictionary on your first lookup).
- **[Anki](https://apps.ankiweb.net/)** (desktop) with the **AnkiConnect** add-on, to add cards.
- Optional: [Yomitan](https://yomitan.wiki/), if you want its popup dictionary on manga pages.
- Optional: an API key from [DeepSeek](https://platform.deepseek.com/) or another OpenAI-compatible provider, if you don't want to use the free explanations.

---

## Install

Install **Manga OCR & Mining for Anki** from the [Chrome Web Store](https://chromewebstore.google.com/detail/bgfnpifeeclmpfdcahphaiahgafjppeo), then click the puzzle-piece icon in the toolbar and **pin** it so its icon is always visible.

> The Store listing is not published yet. Until then, load the extension from source (see [Development](#development)): download the repository, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder.

---

## Anki and AnkiConnect

1. Install [Anki](https://apps.ankiweb.net/) if you don't have it, and open it.
2. In Anki: **Tools → Add-ons → Get Add-ons…**, enter the code **`2055492159`**, and click OK.
3. **Restart Anki.**

Anki just needs to be open when you add cards. Reading and explanations work without it.

The first time the extension talks to Anki, Anki shows a permission prompt ("allow this extension to use AnkiConnect"). Accept it. If you decline, the panel tells you what to do (accept the prompt, or add the extension's origin to `webCorsOriginList` in AnkiConnect's config). The extension talks to AnkiConnect only on `127.0.0.1`.

The extension creates a note type called **Manga Mining (anki_manga)** in Anki by itself. You don't need to set it up.

---

## First run

1. Click the extension icon. The side panel opens on the right.
2. The status in the top-right corner of the panel goes `Downloading models… N%`, then `Loading models…`, then `Ready (WebGPU)` or `Ready (CPU)`. The first download takes a few minutes (about 340 MB with WebGPU, about 190 MB on the CPU; the 11 MB dictionary is fetched when you first look up a word); later starts take a few seconds. Every file is checked against a SHA-256 hash, and what is downloaded is data only, never code.
3. Open **Settings** in the panel and pick the **Anki deck** new cards should go to. Anki must be open for the list to load. Click **Connect to Anki** if the panel asks, and accept the prompt in Anki.
4. Open a chapter on your manga reader site and click **Enable on this site** in the panel. Chrome asks for access to **that site only**. Click **Allow**.
5. Many sites load images from a separate image server. If the panel then shows a button like **Allow images from cdn.example.com**, click it once and allow.

You can sit through the model download while you read: bubbles are processed as soon as the models are ready.

---

## Reading and mining

1. Scroll through the chapter. Pages are processed shortly before they scroll into view, so usually the bubbles are ready by the time you get there. Long-strip "scroll" readers and one-page-at-a-time readers both work. If you hover a bubble that isn't read yet (it has a dashed outline), it jumps to the front of the queue.
2. **Hold Shift and hover** a word in a bubble to get the Yomitan popup (if you installed Yomitan).
3. **Click** a bubble (without Shift). The panel shows:
   - the sentence **with furigana** (instant)
   - a **translation** and **grammar notes** explaining why it's said that way (a second or two)
   - **suggested words**, each with a **+** button
4. **Click a word** in the sentence to see its dictionary entry.
5. Click **+** next to a word: a card appears in your deck and the row shows `✓ added`.

| Action | How |
|---|---|
| Look up a word with Yomitan | Hold **Shift** and hover it |
| Explain a bubble | **Click** it, or hover it and press **Alt+E** |
| Dictionary entry of a word | Click the word in the panel's sentence |
| Add a card | **+** next to a suggested word in the panel |
| Show or hide the hidden text layer (to check alignment) | **Alt+V** |
| Stop using it on a site | Panel → **Disable on this site** |

Readers that draw pages on a `<canvas>` instead of using images also work, through a screenshot fallback (also used for images that can't be downloaded). The page has to be fully on screen, and Chrome asks once for permission to take screenshots.

**Settings → Text recognition** chooses between *Auto*, *Prefetch* (read every bubble in advance) and *On demand* (read a bubble when you hover it). *Auto* is fine for most people.

### What's on a card

The **Manga Mining (anki_manga)** note type has these fields:

| Field | Contents |
|---|---|
| Word | the word you added |
| Reading | its kana reading |
| Meaning | a short meaning |
| Sentence | the whole bubble, with the word in **bold** |
| SentenceFurigana | the bubble with furigana |
| SentenceTranslation | the translation |
| Explanation | the grammar notes |
| Picture | the comic panel the bubble is in |
| Source | a link back to the page |

Cards are tagged `anki_manga`. You can restyle the card template in Anki (**Tools → Manage Note Types → Manga Mining (anki_manga) → Cards**) and your changes are kept.

---

## Explanations: free tier or your own key

Choose in **Settings → Explanations**. The hint under the options says where the text goes in the mode you picked.

- **Free.** No account and no key. Up to 100 explanations per install per day (the panel shows how many are left today), paid for by the project owner within a monthly budget. When the day's limit or the month's budget runs out, the panel says so and offers to switch to your own key. Identical bubble texts are answered from a shared cache, so they don't count twice. Each request carries the bubble text, a random install ID (pseudonymous, made on your device, not linked to a name or account) and the prompt version; the server also sees your network address and keeps only a salted hash of it for the limits.
- **Use my own API key.** Pick **DeepSeek** or **Custom (OpenAI-compatible)** (with a base URL; Chrome asks for permission to talk to that host once). Paste your key and, optionally, a model name (the default is `deepseek-flash`). The text of the bubble you click goes straight from your browser to your provider. Your key is stored locally in the extension's storage and sent to your selected provider with each request, for authentication. **Delete saved key** (shown once a key is saved) removes it; if you were using your own key, explanations then switch to Off, not to the free server.
  - DeepSeek: sign up at [platform.deepseek.com](https://platform.deepseek.com/), top up a small balance, then **API keys → Create new API key** (it starts with `sk-`). One explanation is a few hundred tokens, a tiny fraction of a cent; see [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing).
- **Off.** No bubble text is sent anywhere. Clicking a bubble still shows the furigana and the dictionary, and "+" still makes cards; only the translation and notes are missing. The models, the dictionary and page images still download as usual.

Every answer is cached on your device, so clicking the same bubble again costs nothing and doesn't count against the free limit.

---

## Dictionary

The panel has an offline dictionary based on [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) (English glosses). It is downloaded the first time you look up a word (the models download after installation) and runs on your device. Click a word in the panel's sentence to see readings, parts of speech and meanings. Words are split with kuromoji. The dictionary is independent of Yomitan, which keeps working with its own dictionaries.

---

## Status badges

A small badge sits in the top-right corner of each page image:

| Badge | Meaning |
|---|---|
| `⏳ finding bubbles…` | the page is being scanned for speech bubbles |
| `⏳ 4/11` | 4 of the 11 bubbles have been read so far |
| `✓ 11` | all done (the badge fades out after a moment) |
| `✓ no text` | the page has no text bubbles |
| `⏳ downloading models…` / `⏳ loading models…` | the models aren't ready yet; the page continues by itself |
| `⚠ allow images in the side panel` | click **Allow images from …** in the panel |
| `⚠ can't load this image` | the site blocks direct image downloads; the extension falls back to screenshots, so allow screenshots if asked |
| `⚠ allow screenshots in the side panel` | the screenshot fallback needs permission |
| `⚠ can't read this image` | the image is in a format the browser can't decode |
| `⚠ recognition failed — see the side panel` | the engine hit an error; the panel says more |
| `⚠ extension reloaded — refresh the page` | reload the tab (⌘R / Ctrl+R) |

The panel shows a summary for the tab, for example `Pages: 6 ready · 1 recognizing`. The top of the panel shows the model status: `Ready (WebGPU)`, `Ready (CPU)`, a download progress, or a red message with a **Retry** button.

---

## Yomitan (optional)

1. Install [Yomitan from the Chrome Web Store](https://chromewebstore.google.com/detail/yomitan/likgccmbimhjbgkjambclfkhldnlhbnn).
2. On its welcome page, import a dictionary. [Jitendex](https://jitendex.org/) is a good Japanese–English one.
3. Yomitan looks words up when you **hold Shift and move the mouse** over text. That's its default, and the extension relies on it.

### Make Yomitan use the same note type

Yomitan's own "+" keeps working however you configured it. To give its cards the same layout as the panel's:

1. Yomitan **Settings → Anki**: turn on **Enable Anki integration**.
2. **Configure Anki card format…**: pick your deck and the model **Manga Mining (anki_manga)**.
3. Map the fields:

| Field | Value |
|---|---|
| Word | `{expression}` |
| Reading | `{reading}` |
| Meaning | `{glossary-brief}` |
| Sentence | `{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}` |

Leave the other fields empty. The panel fills them when you add from there. Because each bubble is its own block of text, Yomitan's `{sentence}` is exactly the bubble.

---

## Troubleshooting

**First, the three usual causes:**
1. Does the panel say `Ready (…)` at the top? If it is still downloading or loading, wait.
2. Is Anki open? It's only needed for decks and cards.
3. Did you reload the manga tab after enabling the site or updating the extension?

| You see | What to do |
|---|---|
| `Downloading models… N%` / badge `⏳ downloading models…` | Wait. It takes a few minutes the first time and happens once. |
| `Model download failed — check your connection.` | Check your connection and click **Retry**. |
| `A downloaded model file failed its check.` | Click **Retry**. If it keeps failing, use Settings → **Delete downloaded models and caches**, then **Download again**. |
| `The OCR engine failed to start.` | Click **Retry**. Open an issue if it persists (include your Chrome version). |
| Button **Allow images from …** / badge `⚠ allow images in the side panel` | Click the button in the panel and allow. |
| Badge `⚠ extension reloaded — refresh the page` | Reload the tab. |
| Badge `⚠ can't load this image` | The site blocks direct image downloads. Allow screenshots if asked. |
| No badges, nothing happens | Check that the panel says **Disable on this site** (that means it's enabled). Reload the tab. If it's still empty, look at the `Pages:` line. |
| Yomitan doesn't pop up | Hold **Shift** while hovering. Check that Yomitan is enabled and has a dictionary. Press **Alt+V**: if no red text appears, the page isn't processed yet (see the badge). |
| The red text (Alt+V) is offset from the bubbles | Resize the window slightly. If it persists, open an issue with a screenshot. |
| **Anki isn't running…** | Open Anki. Explanations still work, but cards can't be added until Anki is open. |
| **Anki refused this extension…** | Accept the AnkiConnect permission prompt in Anki, or add the extension's origin to `webCorsOriginList` in AnkiConnect's config and restart Anki. |
| **Today's free explanations are used up…** | They reset tomorrow (UTC). Or add your own API key in Settings. |
| **The free explanation service is unavailable…** | Try again later or add your own API key. |
| **Add your DeepSeek API key in Settings…** | Settings → paste key → Save. |
| **DeepSeek rejected the API key** | Check the key on platform.deepseek.com, or create a new one. |
| **Your DeepSeek account has no balance** | Top up on platform.deepseek.com. |
| **The dictionary could not be loaded…** | Check your connection and click the word again. |

Settings, the saved API key, the list of enabled sites and caches live in the browser. Settings → **Delete downloaded models and caches** removes the downloaded models and dictionary and the caches of pages, recognized text and explanations (up to 300 stored page images, no time limit). It keeps your settings, the saved key (use **Delete saved key**), the list of enabled sites and your Anki data, and it does not touch data on the free server. Removing the extension removes all local data. Your Anki cards stay.

Still stuck? [Open an issue](https://github.com/Suraba03/anki_manga/issues) with what the panel says.

---

## Privacy

Full text: [docs/privacy.md](docs/privacy.md) (published at <https://suraba03.github.io/anki_manga/privacy>).

- **The extension never uploads page images.** Detection and OCR run in the browser. Pictures you add to Anki cards are stored in Anki and follow your Anki sync settings (AnkiWeb sync uploads them if you use it).
- **The text of a bubble you click is sent** only to get an explanation, and not at all if Explanations is **Off**. Free mode: the text, a pseudonymous random install ID and the prompt version go to the project's free server, which also sees your network address for the limits. Own key: the text goes straight to your provider, with your key.
- The free server stores a shared cache of explanations (bubble text and answer) and counters for the limits (per install ID, per salted hash of the address, per month). No page images, no URLs, no analytics, no tracking. The server's own log lines contain no bubble text, install ID or address.
- AnkiConnect is contacted only on `127.0.0.1`; besides adding cards, the extension reads the notes in your decks to grey out known words. Settings and your API key are stored in the browser on your device (the key is sent only to the provider you chose).

---

## Development

The extension is plain ES modules and classic content scripts, with no build step. `extension/` is exactly what ships.

```sh
cd extension && npm ci && node --test     # extension tests (dev dependencies only: fake-indexeddb, kuromoji, onnxruntime-node, jpeg-js)
cd server && node --test                  # free-tier Worker tests (no install needed)
```

- **Load from source:** `chrome://extensions` → Developer mode → **Load unpacked** → the `extension` folder. After editing files: ↻ on the extension, then reload the tab.
- **Manual browser checks:** [`extension/test/manual-checklist.md`](extension/test/manual-checklist.md).
- **Model tests** are skipped unless these are set:
  - `ANKI_MANGA_SAMPLES`: folder with `*.jpg` sample pages and `reference/*.json` (made by `tools/make-reference.py`, which needs a Python env with the v1 helper from git history, see its docstring). Your own pages; never commit them.
  - `ANKI_MANGA_MODELS`: folder with the model files (default `tools/.cache/models`).
  - `ANKI_MANGA_MODEL_SET=webgpu`: test the fp16 encoder and fp32 decoder instead of the q4 CPU set.
- **End to end:** `ANKI_MANGA_SAMPLES=/path/to/pages node tools/e2e/run.mjs --smoke` launches Chrome for Testing with the unpacked extension, serves the sample pages and the mirrored models from `127.0.0.1:47900`, and waits for the text layer. `--probe` checks the platform (offscreen document, WebGPU, cross-origin fetch). Anki is faked on port 8766; the real AnkiConnect on 8765 is never touched.
- **Models and dictionary:**
  - `node tools/mirror-models.mjs` downloads the model files at pinned Hugging Face revisions, hashes them into `tools/.cache/mirror/` and writes `extension/engine/models.manifest.json` (URLs on the GitHub release `models-1`). `--upload` also creates the release: that publishes, so it needs the owner.
  - `node tools/build-dict.mjs` builds the dictionary from [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) and records it in the same manifest.
- **Free-tier server** (`server/`, Cloudflare Worker with D1):
  1. `cd server && npm install`
  2. `npx wrangler d1 create anki-manga`, paste the printed id into `wrangler.toml`, then `npx wrangler d1 execute anki-manga --remote --file schema.sql`
  3. `npx wrangler secret put DEEPSEEK_API_KEY` and `npx wrangler secret put IP_SALT`
  4. Check the price and model variables in `wrangler.toml`, then `npm run deploy`
  5. Put the Worker's URL in `FREE_URL` in `extension/lib/llm.js` and in the manifest's `host_permissions`; `ALLOWED_ORIGINS` in `server/wrangler.toml` lists the Store build's origin and, for now, the maintainer's two unpacked development builds; for your own unpacked build add `chrome-extension://<id>` (shown on `chrome://extensions`).

  `npm run dev` runs it locally. Deploying is the owner's step.
- **Store package:** `node tools/package.mjs` writes `dist/manga-mining-<version>.zip` (the `extension/` folder without `test/`, `node_modules/` and `package*.json`). `--out <dir>` changes the folder.

**Roadmap:**
- **v2:** explanations adapted to your level, and follow-up questions about a bubble.
- **v3:** "make this chapter a lesson", with prep before reading and a recap after.
- **v4:** suggestions based on words you look up repeatedly.

---

## Licences

GPL-3.0-or-later (see [LICENSE](LICENSE)). Built on:

- [comic-text-detector](https://github.com/dmMaze/comic-text-detector) (GPL-3.0), the bubble and text detector, run as an ONNX model
- [manga-ocr](https://github.com/kha-white/manga-ocr) (Apache-2.0), the text recognition model, run as an ONNX model
- [mokuro](https://github.com/kha-white/mokuro) (GPL-3.0), whose pipeline the first version of this project was built on
- [JMdict](https://www.edrdg.org/edrdg/licence.html) by the Electronic Dictionary Research and Development Group (CC BY-SA 4.0), through [jmdict-simplified](https://github.com/scriptin/jmdict-simplified)
- [kuromoji](https://github.com/takuyaa/kuromoji.js) (Apache-2.0), word splitting, with the IPADIC dictionary (NAIST / ICOT licence; the notice is in `extension/vendor/kuromoji/NOTICE.md` and ships in the package)
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), the inference engine

Model weights and the dictionary are data downloaded at runtime from pinned URLs and verified by SHA-256; they are not part of the extension package. The exact sources and licences of each file are recorded in `extension/engine/models.manifest.json`.

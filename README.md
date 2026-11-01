# anki_manga

**English** · [Русский](README.ru.md)

Read Japanese manga in Chrome and turn speech bubbles into Anki cards with almost no friction.

<!-- GIF: hover a bubble with Yomitan, click it, add a card from the panel -->

- **Hover** any speech bubble with [Yomitan](https://yomitan.wiki/) (hold Shift). The bubble's text is OCR'd on your computer and laid invisibly over the image, so Yomitan works on manga pages, and the card's sentence is exactly that bubble.
- **Click** a bubble to open the side panel. It shows the line with furigana, a translation, a short explanation of *why it's written that way*, and the words worth learning.
- **"+"** adds a rich card to Anki: the word, its reading and meaning, the bubble sentence with the word in bold, furigana, translation, grammar notes, a picture of the comic panel, and a link back to the page. Words already in your deck are greyed out.

OCR runs locally ([manga-ocr](https://github.com/kha-white/manga-ocr) and comic-text-detector, through [mokuro](https://github.com/kha-white/mokuro)). Explanations use **your own** DeepSeek API key. Only the text of the bubbles you click is sent, and every answer is cached, so the same bubble is never paid for twice.

---

## Contents

1. [How it works](#how-it-works)
2. [What you need](#what-you-need)
3. [Installation, step by step](#installation-step-by-step)
4. [First chapter](#first-chapter)
5. [Everyday use](#everyday-use)
6. [Optional extras](#optional-extras)
7. [Updating and uninstalling](#updating-and-uninstalling)
8. [Troubleshooting](#troubleshooting)
9. [Privacy and costs](#privacy-and-costs)
10. [Development](#development)
11. [License](#license)

---

## How it works

There are two parts, and both have to be running while you read:

| Part | What it is | What it does |
|---|---|---|
| **Helper** | A small program you start in Terminal (`anki-manga-helper`). It stays on your computer and listens only on `127.0.0.1`. | Finds the speech bubbles, reads their text (OCR), caches the results, talks to DeepSeek and Anki. |
| **Extension** | A Chrome extension with a side panel. | Sends manga pages to the helper, places the invisible text layer for Yomitan, and shows explanations and "+" buttons. |

Anki (with AnkiConnect) must be open to add cards. Yomitan is optional: without it you can still click bubbles for explanations and cards.

---

## What you need

- **macOS.** Apple Silicon (M1 or newer) is fastest. Intel Macs, Linux and Windows may work but are untested.
- **Google Chrome** 116 or newer. Other Chromium browsers may work.
- About **3 GB of free disk space** for the OCR models and PyTorch.
- **[Anki](https://apps.ankiweb.net/)** (desktop) with the **AnkiConnect** add-on.
- A **DeepSeek API key** with a little balance, for explanations. A few dollars lasts a very long time ([costs](#privacy-and-costs)).
- **[uv](https://docs.astral.sh/uv/)**, which installs the helper and its own Python for you. You don't need to install Python yourself.

---

## Installation, step by step

Plan for 15–20 minutes, most of it waiting for downloads. You do this once.

### Step 1. Install uv

Open **Terminal** (⌘ Space, type "Terminal", press Enter) and paste:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

If you use Homebrew, `brew install uv` works too.

**Close Terminal and open it again**, then check:

```sh
uv --version
```

You should see something like `uv 0.x.y`. If you see `command not found`, open a new Terminal window and try again.

### Step 2. Install the helper

```sh
uv tool install "git+https://github.com/Suraba03/anki_manga#subdirectory=helper"
```

This downloads the helper and its dependencies (PyTorch is the big one), which takes a few minutes. It ends with `Installed 1 executable: anki-manga-helper`.

If uv warns that `~/.local/bin` is not on your PATH, run `uv tool update-shell`, then close and reopen Terminal.

### Step 3. Start the helper (first start downloads models)

```sh
anki-manga-helper
```

On the **first start** it downloads the OCR models (about 500 MB), which can take a few minutes. When it is done it prints:

```
ready
```

Every later start takes a few seconds. **Leave this Terminal window open while you read.** Closing it stops the helper. To stop it on purpose, press `Ctrl+C`. To have it start by itself at login, see [Start the helper automatically](#start-the-helper-automatically).

### Step 4. Install Anki and AnkiConnect

1. Install [Anki](https://apps.ankiweb.net/) if you don't have it, and open it.
2. In Anki: **Tools → Add-ons → Get Add-ons…**, enter the code **`2055492159`**, and click OK.
3. **Restart Anki.**

AnkiConnect has nothing to configure. Anki just needs to be open when you add cards.

### Step 5. Install the Chrome extension

The extension isn't on the Chrome Web Store, so you load it from a folder:

1. Download this repository. On GitHub, click the green **Code** button, then **Download ZIP**. Unzip it somewhere permanent, such as `~/Applications/anki_manga`. (Or run `git clone https://github.com/Suraba03/anki_manga.git`.)
   > ⚠️ Chrome loads the extension from that folder every time. Don't delete or move it after loading.
2. In Chrome, open **`chrome://extensions`**.
3. Turn on **Developer mode** (the switch in the top-right corner).
4. Click **Load unpacked** and choose the **`extension`** folder inside the downloaded repository. Choose `extension`, not the whole repository.
5. Click the puzzle-piece icon in the Chrome toolbar and **pin** anki_manga, so its icon is always visible.

### Step 6. Connect the extension and add your DeepSeek key

1. Get a key. Sign up at [platform.deepseek.com](https://platform.deepseek.com/), top up a small balance under **Top up**, then open **API keys → Create new API key** and copy it (it starts with `sk-`).
2. Click the **anki_manga icon** in the toolbar. The side panel opens on the right.
3. The status in the top-right corner should say **● Helper ready** in green. If it doesn't, see [Troubleshooting](#troubleshooting).
4. **⚙ Settings — API key & deck** opens by itself the first time. Paste your key and click **Save**. You should see **Key saved.**
5. Pick the **deck** new cards should go to. The list comes from Anki, so Anki must be open.

At this point anki_manga has created a note type called **Manga Mining (anki_manga)** in Anki. You don't need to set it up.

Your key is stored only by the helper on your computer. It's never saved in the extension or sent anywhere except DeepSeek.

### Step 7. Install Yomitan (recommended)

1. Install [Yomitan from the Chrome Web Store](https://chromewebstore.google.com/detail/yomitan/likgccmbimhjbgkjambclfkhldnlhbnn).
2. On its welcome page, import a dictionary. [Jitendex](https://jitendex.org/) is a good Japanese–English one.
3. Yomitan looks words up when you **hold Shift and move the mouse** over text. That's its default, and anki_manga relies on it.
4. Optional: set up Yomitan's Anki tab so its own "+" creates cards. See [Make Yomitan use the same note type](#make-yomitan-use-the-same-note-type).

You're done with installation.

---

## First chapter

1. Open a chapter on your manga reader site. Long-strip "scroll" readers and one-page-at-a-time readers both work.
2. Open the side panel (anki_manga icon) and click **Enable on this site**. Chrome asks for access to **that site only**. Click **Allow**.
3. Many sites load images from a separate image server. If the panel then shows a button like **Allow images from cdn.example.com**, click it once and allow.
4. Watch the **badge in the top-right corner of each page**:
   - `⏳ finding bubbles…`: the helper is looking for speech bubbles.
   - `⏳ 4/11`: 4 of the 11 bubbles have been read so far.
   - `✓ 11`: all done. The badge fades out after a moment.
   - `⚠ …`: something is wrong, and the text says what. It stays until the problem is fixed.

   The panel shows a summary for the tab, for example `Pages: 6 ready · 1 recognizing`.
5. **Hold Shift and hover** a word in a bubble: the Yomitan popup appears.
6. **Click** a bubble (without Shift). The panel shows:
   - the sentence **with furigana** (instant)
   - a **translation** and **grammar notes** explaining why it's said that way (a second or two)
   - **suggested words**, each with a **+** button
7. Click **+** next to a word: a card appears in your deck and the row shows `✓ added`.

Pages are processed shortly before they scroll into view, so usually the bubbles are ready by the time you get there. If you hover a bubble that isn't read yet (it has a dashed outline), it jumps to the front of the queue.

---

## Everyday use

1. Open Anki.
2. Start the helper: `anki-manga-helper` in Terminal (or let it [start automatically](#start-the-helper-automatically)).
3. Read in Chrome. Sites you enabled stay enabled.

| Action | How |
|---|---|
| Look up a word | Hold **Shift** and hover it (Yomitan) |
| Explain a bubble | **Click** it, or hover it and press **Alt+E** |
| Add a card | **+** next to a suggested word in the panel |
| Show or hide the hidden text layer (to check alignment) | **Alt+V** |
| Stop using it on a site | Panel → **Disable on this site** |

Readers that draw pages on a `<canvas>` instead of using images also work, through a screenshot fallback. The page has to be fully on screen, and Chrome asks once for permission to take screenshots.

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

## Optional extras

### Start the helper automatically

So that you never need Terminal again, make macOS start the helper at login and restart it if it stops. Paste this into Terminal once:

```sh
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.anki-manga.helper.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.anki-manga.helper</string>
  <key>ProgramArguments</key><array><string>$HOME/.local/bin/anki-manga-helper</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/anki-manga-helper.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/anki-manga-helper.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anki-manga.helper.plist
```

- Check that it runs: `tail ~/Library/Logs/anki-manga-helper.log` should end with `ready`.
- Restart it (for example after an update): `launchctl kickstart -k gui/$(id -u)/com.anki-manga.helper`
- Turn it off: `launchctl bootout gui/$(id -u)/com.anki-manga.helper && rm ~/Library/LaunchAgents/com.anki-manga.helper.plist`

If `which anki-manga-helper` prints a path other than `~/.local/bin/anki-manga-helper`, put that path in the file instead.

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

## Updating and uninstalling

**Update:**

```sh
uv tool upgrade anki-manga-helper
```

Then restart the helper. For the extension, download the repository again into the **same folder** (or `git pull` there). Then go to `chrome://extensions`, click **↻** on anki_manga, and reload your manga tabs.

**Uninstall:**

```sh
uv tool uninstall anki-manga-helper
rm -rf ~/Library/Application\ Support/anki_manga ~/Library/Caches/anki_manga
```

Then remove the extension in `chrome://extensions`. If you set up autostart, turn it off first (see above). The OCR models are in `~/.cache/huggingface` and `~/.cache/manga-ocr` if you want that space back. Your Anki cards stay.

---

## Troubleshooting

**First, the three usual causes:**
1. Is the helper running? Its Terminal window should say `ready`.
2. Is Anki open? It's only needed for decks and cards.
3. Did you reload the manga tab after enabling the site or updating the extension?

| You see | What to do |
|---|---|
| Panel: **● Helper not running** / badge `⚠ helper not running` | Start `anki-manga-helper` in Terminal. Pages retry by themselves. |
| Panel: **Loading OCR models…** / badge `⏳ helper starting…` | Wait. It takes 3–10 s, or a few minutes on the very first start. |
| Panel: **● Model loading failed** | Look at the helper's Terminal window for the error. Usually the first model download was interrupted: stop the helper (`Ctrl+C`) and start it again. |
| **This helper is paired with another install** | This happens after you reinstall the extension. Run `anki-manga-helper --reset-pairing`, restart the helper, and reopen the panel. |
| Badge `⚠ not paired — open the side panel` | Open the side panel once. It pairs automatically. |
| Button **Allow images from …** / badge `⚠ allow images in the side panel` | Click the button in the panel and allow. |
| Badge `⚠ extension reloaded — refresh the page` | Reload the tab (⌘R). |
| Badge `⚠ can't load this image` | The site blocks direct image downloads. The extension falls back to screenshots, so allow screenshots if asked. |
| No badges, nothing happens | Check that the panel says **Disable on this site** (that means it's enabled). Reload the tab. If it's still empty, open the panel and look at the `Pages:` line. |
| Yomitan doesn't pop up | Hold **Shift** while hovering. Check that Yomitan is enabled and has a dictionary. Press **Alt+V**: if no red text appears, the page isn't processed yet (see the badge). |
| The red text (Alt+V) is offset from the bubbles | Resize the window slightly. If it persists, open an issue with the site's name and a screenshot. |
| **Anki isn't running…** | Open Anki. Explanations still work, but cards can't be added until Anki is open. |
| **Add your DeepSeek API key in Settings…** | Settings → paste key → Save. |
| **DeepSeek rejected the API key** | Check the key on platform.deepseek.com, or create a new one. |
| **Your DeepSeek account has no balance** | Top up on platform.deepseek.com. |
| `command not found: anki-manga-helper` | Run `uv tool update-shell`, then reopen Terminal. |

**Where things live** (macOS):
- Settings and the API key: `~/Library/Application Support/anki_manga/config.json`, readable only by your user.
- Cache (OCR results, explanations, the last 300 page images): `~/Library/Caches/anki_manga/`. Deleting it is safe.
- Set `ANKI_MANGA_HOME=/some/folder` to keep both there instead.

Still stuck? [Open an issue](https://github.com/Suraba03/anki_manga/issues) with what the panel and the helper's Terminal window say.

---

## Privacy and costs

- **Page images never leave your computer.** They go only to the helper on `127.0.0.1`, which refuses requests from web pages, accepts only this extension (paired with a secret token), and listens only locally.
- **DeepSeek receives only the text of a bubble you click**, once. The answer is cached, and clicking the same bubble again costs nothing.
- **Your API key** is stored only in the helper's local config file (mode 0600). It's never in the extension, in Chrome sync, or in this repository.
- **Cost:** one explanation is a few hundred tokens, a tiny fraction of a cent with `deepseek-chat`. A whole chapter where you click every bubble usually costs less than a cent. See [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing).

---

## Development

```sh
cd helper && uv sync --extra dev && uv run pytest -m "not models"   # fast tests
ANKI_MANGA_SAMPLES=/path/to/pages uv run pytest -m models             # real-model tests
uv run anki-manga-helper                                              # run from source
cd extension && node --test                                           # extension logic
```

- After editing extension files: `chrome://extensions` → ↻ → reload the tab.
- Manual browser checks: [`extension/test/manual-checklist.md`](extension/test/manual-checklist.md).
- Design and plan: [`docs/superpowers/`](docs/superpowers/).

**Roadmap:**
- **v2:** explanations adapted to your level, and follow-up questions about a bubble.
- **v3:** "make this chapter a lesson", with prep before reading and a recap after.
- **v4:** suggestions based on words you look up repeatedly.
- **Later:** standalone dictionary popups without Yomitan.

---

## License

GPL-3.0-or-later. Built on [mokuro](https://github.com/kha-white/mokuro) (GPL-3.0), [manga-ocr](https://github.com/kha-white/manga-ocr) (Apache-2.0) and [comic-text-detector](https://github.com/dmMaze/comic-text-detector). Model weights are downloaded at runtime.

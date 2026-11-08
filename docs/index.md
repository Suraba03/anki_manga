---
title: Manga OCR & Mining for Anki
---

# Manga OCR & Mining for Anki

A Chrome extension for reading Japanese manga in the original and turning the lines you don't know into Anki cards.

- **OCR in your browser.** It finds the speech bubbles on a manga page and reads their text on your own device (WebGPU, with a CPU fallback). The extension never uploads page images.
- **Click a bubble.** The side panel shows the line with furigana and a short English explanation of the grammar and nuance.
- **Built-in dictionary.** Click any word for its JMdict entry. Nothing to set up.
- **One-click Anki cards.** The "+" next to a word adds it to Anki (through AnkiConnect) with its reading and meaning, the sentence with furigana and its translation, the explanation and a picture of the bubble.

Explanations are free up to 100 per day with no account, or use your own DeepSeek or other OpenAI-compatible API key.

## Get it

- Chrome Web Store: coming soon
- Try it: [a demo manga page](demo/) (an original drawing) to test the extension on
- Source code, setup and troubleshooting: [github.com/Suraba03/anki_manga](https://github.com/Suraba03/anki_manga)

## Privacy

The extension never uploads page images. The text of a bubble you click is sent only to get an explanation: to the free server with a pseudonymous random install ID, or to your own provider with your key. Turn Explanations off and no bubble text is sent. No analytics, no tracking. Read the [privacy policy](privacy/).

## Licence

GPL-3.0-or-later. Dictionary data: JMdict by the Electronic Dictionary Research and Development Group, used under CC BY-SA 4.0.

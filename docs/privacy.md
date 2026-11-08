---
title: Privacy policy
permalink: /privacy/
---

# Privacy policy: Manga OCR & Mining for Anki

Last updated: 2026-11-02

Manga OCR & Mining for Anki is a Chrome extension that reads speech bubbles on manga pages in your browser and helps you make Anki cards. This page says what it does with your data. The code is open: <https://github.com/Suraba03/anki_manga>.

## In short

- Page images never leave your device.
- The only thing that can leave your device is the text of a bubble you click, and only to get an explanation.
- No analytics, no tracking, no ads, no accounts.

## What stays on your device

- **Page images.** Bubble detection and text recognition (OCR) run inside your browser. The images are not uploaded anywhere.
- **Recognized text, the dictionary and caches.** They are kept in the browser (IndexedDB and the extension's storage). The "Delete downloaded models and caches" button in the panel removes them.
- **Settings and keys.** Your settings, the list of sites you enabled, and an API key if you add one are stored in `chrome.storage` on your device. The extension never sends them to the owner.
- **Anki.** The extension talks to AnkiConnect only on `127.0.0.1` (your own computer) to list decks and add cards.

## What is sent over the network

1. **Model and dictionary download (first run).** The extension downloads the OCR models and the JMdict dictionary from this project's GitHub release. These are plain file downloads; the extension sends no data about you or your pages, and GitHub sees the request as it would for any download.

2. **Explanations: free mode.** When you click a bubble, the text of that bubble (at most 300 characters) is sent to the project owner's server, which runs on Cloudflare Workers and asks DeepSeek for the explanation. Together with the text the extension sends a random install ID and the prompt version. The install ID is generated on your device the first time you run the extension; it is not linked to your name, your Google account or any other identifier. The server keeps:
   - a **shared cache** of explanations: the bubble text and the explanation that was generated, so the same line is not paid for twice. It is not linked to who asked. A cached entry is deleted when it has not been used for **180 days**;
   - **counters** used for the free limits: the number of explanations per install ID per day, the number per network address per day, the number of failed paid calls (those that returned no explanation) per network address per day, and the total spend per month. The per-day counters are deleted after **2 days**, and the monthly spend totals (which contain no personal data) after **13 months**. The per-address counters do not hold the address itself but a pseudonymous hash of it, made with a secret salt that is known only to the server. They are still treated as personal data and are deleted after 2 days, like the install ID counter;
   - nothing else: no page images, no page URLs, no site names, no names or emails.

   The server is hosted on Cloudflare, which, like any host, sees the network address of a request while handling it. The server code does not store that address.

   Cleanup runs automatically once a day.

   The text is forwarded to DeepSeek to produce the answer, so DeepSeek's privacy policy applies to it too.

3. **Explanations: your own key.** If you switch to your own API key (DeepSeek or another OpenAI-compatible provider), the bubble text is sent directly from your browser to the provider you chose, with your key. It does not pass through the owner's server. The provider's own privacy policy and terms apply.

4. **Nothing else.** Apart from loading the page images from the manga site you are reading (to read them on your device) and talking to Anki on `127.0.0.1`, the extension makes no other requests. It has no analytics or tracking code and does not use cookies.

## Permissions

- **Access to the sites you enable.** The extension asks for access to a manga site only when you click "Enable on this site", and uses it to find the page images and show the text layer there. You can turn it off per site in the panel.
- **Screenshots.** Only if a site draws pages on a canvas, and only after you agree. The screenshot is processed on your device like any other page image.

## Your choices

- Use your own key, or no explanations at all (reading, OCR, the dictionary and Anki cards work without them).
- Delete the models and caches from the panel, or remove the extension: all local data goes with it.
- To ask about or request the removal of a cached explanation before its 180 days are up, open an issue (below). Because the cache is not linked to you, please quote the text.

## Children

The extension is not directed at children and collects no personal data.

## Changes and contact

If this policy changes, the date above changes with it and the change is visible in the repository history. Questions and requests: open an issue at <https://github.com/Suraba03/anki_manga/issues>.

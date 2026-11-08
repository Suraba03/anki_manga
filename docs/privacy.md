---
title: Privacy policy
permalink: /privacy/
---

# Privacy policy: Manga OCR & Mining for Anki

Last updated: 2026-11-08

Manga OCR & Mining for Anki is a Chrome extension that reads speech bubbles on manga pages in your browser and helps you make Anki cards. This page says what it does with your data. The code is open: <https://github.com/Suraba03/anki_manga>.

## In short

- The extension never uploads page images. They are read on your device.
- The text of a bubble you click is sent out only to get an explanation, and only if Explanations is not set to Off. In the free mode it goes with a pseudonymous random install ID and the prompt version, and the server processes your network address to enforce its limits (details below).
- No analytics, no tracking, no ads, no accounts.

## What stays on your device

- **Page images.** Bubble detection and text recognition (OCR) run inside your browser. The extension never uploads the images. It keeps up to 300 page images in the browser for the picture on your cards.
- **Recognized text, the dictionary and caches.** The downloaded models and dictionary are kept in the browser's cache storage. The pages, the recognized text and the explanations are kept in IndexedDB. These caches have no time limit; they are only trimmed to the 300 most recent page images. The "Delete downloaded models and caches" button in the panel removes the downloaded models and dictionary and the IndexedDB caches (pages, recognized text, explanations). It does not remove your settings, the saved API key (use "Delete saved key"), the list of enabled sites, the current selection (kept until the browser session ends), your Anki data, or anything held on the server (see the retention periods below).
- **Settings and keys.** Your settings, the list of sites you enabled, the random install ID, and an API key if you add one are stored in `chrome.storage` on your device. The API key is sent only to the provider you selected, with each request, to authenticate it; it is never sent to the owner. You can remove it with "Delete saved key" in Settings → Explanations.
- **Anki.** The extension talks to AnkiConnect only on `127.0.0.1` (your own computer). It adds cards, lists decks, and reads the existing notes of the deck selected for cards to mark words you already know. A card holds the word, the sentence and its notes, a picture (a crop of the comic panel), and the page's URL and title as the source. Pictures you add to Anki are stored in Anki and follow your Anki sync settings: if you use AnkiWeb sync, they are uploaded there.

Removing the extension removes all of this local data. Your Anki cards stay.

## What is sent over the network

1. **Model and dictionary download.** After installation the extension downloads the OCR models, and the first time you look up a word it downloads the JMdict dictionary, from this project's GitHub release. The size depends on your device: about 340 MB with WebGPU, about 190 MB on the CPU, plus the 11 MB dictionary. These are plain file downloads; the extension sends no data about you or your pages, and GitHub sees the request as it would for any download.

2. **Explanations: free mode.** When you click a bubble, the text of that bubble (at most 300 characters) is sent to the project owner's server, which runs on Cloudflare Workers and asks DeepSeek for the explanation. Together with the text the extension sends a random install ID and the prompt version. The install ID is pseudonymous: it is generated on your device the first time you run the extension and is not linked to your name, your Google account or any other identifier, but it stays the same for as long as the extension is installed, so requests with it can be linked to each other. The server keeps:
   - a **shared cache** of explanations: the bubble text and the explanation that was generated, so the same line is not paid for twice. It is not linked to who asked. A cached entry is deleted when it has not been used for **180 days**;
   - **counters** used for the free limits: the number of explanations per install ID per day, the number per network address per day, the number of failed paid calls (those that returned no explanation) per network address per day, the total spend per month, and the total spend per day. The per-day counters are deleted after **2 days** (the daily spend total contains no personal data), and the monthly spend totals (which contain no personal data) after **13 months**. The per-address counters do not hold the address itself but a pseudonymous hash of it, made with a secret salt that is known only to the server. They are still treated as personal data and are deleted after 2 days, like the install ID counter;
   - a **record of which spend alerts were sent** (the date and time and the alert type only, such as "80% of the monthly budget"), so each alert goes out once. It is deleted after **13 months**;
   - nothing else: no page images, no page URLs, no site names, no names or emails.

   The server is hosted on Cloudflare, which, like any host, sees the network address of a request while handling it. The server code processes the address only to apply the limits and stores just the salted hash described above, not the address itself.

   The server also writes short operational logs (the type and status of an error, the length of an answer, spend totals and alerts). They never contain the bubble text, the install ID or the network address. How long Cloudflare keeps its own logs is set by Cloudflare and is not configured by this project.

   The server sends spend alerts to the developer (through a Telegram bot) when the monthly budget is running out or a day's spend is unusually high. They contain only amounts and dates, never text, network addresses or IDs.

   Cleanup runs automatically once a day.

   The text is forwarded to DeepSeek to produce the answer, so DeepSeek's privacy policy applies to it too.

3. **Explanations: your own key.** If you switch to your own API key (DeepSeek or another OpenAI-compatible provider), the bubble text is sent directly from your browser to the provider you chose, with your key. It does not pass through the owner's server. The provider's own privacy policy and terms apply.

4. **Explanations: Off.** In Settings → Explanations you can choose Off. Then no bubble text is sent anywhere; reading, OCR, the dictionary and Anki cards keep working. The models, the dictionary and page images still download as described above.

5. **Nothing else.** Apart from loading the page images from the manga site you are reading (to read them on your device) and talking to Anki on `127.0.0.1`, the extension makes no other requests. It has no analytics or tracking code and sets no cookies of its own. When it downloads a page image, the request goes to the image site: the request made from the page carries the page's Referer and, for images from the page's own site, its cookies; the request made by the extension's own background page is sent with the image site's cookies and the extension as the referrer.

## Permissions

- **Access to the sites you enable.** The extension asks for access to a manga site only when you click "Enable on this site", and uses it to find the page images and show the text layer there. You can turn it off per site in the panel.
- **Screenshots.** Only if a site draws pages on a canvas or an image cannot be downloaded, and only after you agree. The screenshot of the visible tab is processed on your device like any other page image.

## Your choices

- Use your own key, or turn explanations off (Settings → Explanations → Off): then no bubble text is sent, and reading, OCR, the dictionary and Anki cards work without them.
- Delete the saved API key ("Delete saved key") or the models and caches (see above) from the panel, or remove the extension: all local data goes with it.
- To ask about or request the removal of a cached explanation before its 180 days are up, open an issue (below). Because the cache is not linked to you, please quote the text.

## Chrome Web Store policy

Our handling of user data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements: <https://developer.chrome.com/docs/webstore/program-policies/limited-use>.

## Children

The extension is not directed at children. It asks for no name, email or account.

## Changes and contact

If this policy changes, the date above changes with it and the change is visible in the repository history. Questions and requests: open an issue at <https://github.com/Suraba03/anki_manga/issues>.

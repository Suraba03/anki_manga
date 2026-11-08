import test from "node:test";
import assert from "node:assert/strict";
import {
  explainErrorMessage,
  waitForBubbleText,
  modelStatusLine,
  freeLeftText,
  ankiErrorMessage,
  pictureFilename,
  ownKeyCheck,
  shouldAskPermission,
  llmModeAfter,
  explanationsHint,
  validateBaseUrl,
  freeRemainingAfterError,
  cardDoneState,
  deckChoice,
  resolveDeck,
  deckForCard,
  latestCall,
  deckChanged,
  deckTargetText,
  DEFAULT_DECK,
  NO_DECK,
} from "../panel/logic.js";

test("free-tier and no_text copy is exact", () => {
  assert.deepEqual(explainErrorMessage("free_daily_limit"), {
    text: "Today's free explanations are used up — they reset tomorrow. Add your own API key to keep going.",
    action: "own_key",
  });
  assert.deepEqual(explainErrorMessage("free_monthly_cap", { now: new Date("2026-11-08T10:00:00Z") }), {
    text: "The free service has used its budget for this month; it comes back on December 1. You can add your own API key in Settings.",
    action: "own_key",
  });
  assert.deepEqual(explainErrorMessage("free_unavailable"), {
    text: "The free explanation service is unavailable right now. Try again later or add your own API key.",
    action: "own_key",
  });
  assert.deepEqual(explainErrorMessage("no_text"), { text: "No text was recognized in this bubble.", action: null });
});

test("v1 error copy is unchanged", () => {
  const v1 = {
    no_api_key: "Add your DeepSeek API key in Settings to get explanations.",
    auth: "DeepSeek rejected the API key — check it in Settings.",
    bad_response: "Explanation failed — click the bubble again to retry.",
    no_balance: "Your DeepSeek account has no balance — top it up on platform.deepseek.com.",
    rate_limited: "DeepSeek is rate-limiting requests — wait a moment and click the bubble again.",
    page_expired: "This page is no longer cached — scroll back to it and try again.",
  };
  for (const [code, text] of Object.entries(v1)) assert.deepEqual(explainErrorMessage(code), { text, action: null }, code);
  // v1 showed the generic message for a dropped connection, too
  assert.deepEqual(explainErrorMessage("network"), { text: v1.bad_response, action: null });
});

test("unknown codes name the code", () => {
  assert.deepEqual(explainErrorMessage("zzz"), { text: "Something went wrong (zzz).", action: null });
});

test("model status line", () => {
  const line = (s) => modelStatusLine(s).text.replace(/\u00a0/g, " "); // see the wrap test below
  const MB = 1e6;
  const down = (received, total, etaSec) => ({ state: "downloading", progress: received / total, receivedBytes: received, totalBytes: total, etaSec });
  assert.equal(modelStatusLine(down(120 * MB, 336.7 * MB, 130)).kind, "warming");
  assert.equal(line(down(120 * MB, 336.7 * MB, 130)), "Downloading models: 120 / 337 MB, about 2 min left");
  // A narrow panel may break the line only between the chunks.
  assert.deepEqual(modelStatusLine(down(120 * MB, 336.7 * MB, 130)).text.split(" "), ["Downloading", "models:", "120\u00a0/\u00a0337\u00a0MB,", "about\u00a02\u00a0min\u00a0left"]);
  assert.equal(line(down(0, 336.7 * MB, null)), "Downloading models: 0 / 337 MB", "no estimate yet");
  assert.equal(line(down(300 * MB, 336.7 * MB, 40)), "Downloading models: 300 / 337 MB, less than a minute left");
  assert.equal(line(down(10 * MB, 336.7 * MB, 61 * 60)), "Downloading models: 10 / 337 MB, about 61 min left");
  // Before the size is known, or when everything is cached (warm start): no "Downloading".
  assert.equal(line({ state: "downloading", progress: 0 }), "Starting the OCR engine…");
  assert.equal(line({ state: "downloading", progress: 1, receivedBytes: 0, totalBytes: 0 }), "Starting the OCR engine…");
  assert.deepEqual(modelStatusLine({ state: "loading", progress: 1, ep: "webgpu", firstRun: true }), { kind: "warming", text: "Preparing models (first run only)…", retry: null });
  assert.equal(line({ state: "loading", progress: 1, ep: "webgpu", firstRun: false }), "Starting the OCR engine…");
  assert.equal(line({ state: "loading", progress: 1, ep: "webgpu" }), "Starting the OCR engine…");
  assert.deepEqual(modelStatusLine({ state: "ready", ep: "webgpu" }), { kind: "ready", text: "Ready (WebGPU)", retry: null });
  assert.deepEqual(modelStatusLine({ state: "ready", ep: "wasm" }), { kind: "ready", text: "Ready (CPU)", retry: null });
  assert.deepEqual(modelStatusLine({ state: "error", error: "model_download_failed" }), {
    kind: "down",
    text: "Model download failed — check your connection.",
    retry: "Retry",
  });
  assert.deepEqual(modelStatusLine({ state: "error", error: "model_corrupt" }).text, "A downloaded model file failed its check.");
  assert.deepEqual(modelStatusLine({ state: "error", error: "models_cleared" }), {
    kind: "down",
    text: "Models deleted.",
    retry: "Download again",
  });
  assert.deepEqual(modelStatusLine({ state: "error", error: "engine_error" }).text, "The OCR engine failed to start.");
  assert.deepEqual(modelStatusLine(undefined), { kind: "warming", text: "Starting…", retry: null });
});

test("free remaining text", () => {
  assert.equal(freeLeftText(7), "7 left today");
  assert.equal(freeLeftText(0), "0 left today");
  assert.equal(freeLeftText(null), "");
  assert.equal(freeLeftText(undefined), "");
});

test("anki errors", () => {
  assert.equal(ankiErrorMessage("anki_unreachable"), "Anki isn't running — open Anki with AnkiConnect to add cards.");
  assert.match(ankiErrorMessage("anki_origin_blocked"), /accept the AnkiConnect permission prompt in Anki/);
  assert.match(ankiErrorMessage("anki_origin_blocked"), /webCorsOriginList/);
  assert.match(ankiErrorMessage("anki_error", "boom"), /boom/);
});

test("card picture file name keeps the v1 scheme", () => {
  assert.equal(pictureFilename("0123456789abcdef0123", 7), "anki_manga_0123456789ab_7.jpg");
});

// --- fix round 1 ---------------------------------------------------------------------------
test("a blank key field reuses the stored key only for the same provider and base URL", () => {
  const stored = { provider: "deepseek", baseUrl: "", apiKey: "sk-old" };
  const err = "Enter the API key for this provider.";
  assert.deepEqual(ownKeyCheck(stored, { provider: "deepseek", baseUrl: "", typedKey: "" }), { ok: true, key: "sk-old" });
  assert.deepEqual(ownKeyCheck(stored, { provider: "deepseek", baseUrl: "https://ignored.example", typedKey: " " }), { ok: true, key: "sk-old" });
  assert.deepEqual(ownKeyCheck(stored, { provider: "custom", baseUrl: "https://proxy.example/v1", typedKey: "" }), { ok: false, error: err });
  assert.deepEqual(ownKeyCheck(stored, { provider: "custom", baseUrl: "https://proxy.example/v1", typedKey: " sk-new " }), { ok: true, key: "sk-new" });
  const custom = { provider: "custom", baseUrl: "https://proxy.example/v1", apiKey: "sk-c" };
  assert.deepEqual(ownKeyCheck(custom, { provider: "custom", baseUrl: "https://proxy.example/v1/", typedKey: "" }), { ok: true, key: "sk-c" });
  assert.deepEqual(ownKeyCheck(custom, { provider: "custom", baseUrl: "https://other.example/v1", typedKey: "" }), { ok: false, error: err });
  assert.deepEqual(ownKeyCheck(custom, { provider: "deepseek", baseUrl: "", typedKey: "" }), { ok: false, error: err });
  assert.deepEqual(ownKeyCheck({ provider: "deepseek", baseUrl: "", apiKey: "" }, { provider: "deepseek", baseUrl: "", typedKey: "" }), { ok: false, error: err });
});

test("after a denial only an explicit user action asks for the Anki permission again", () => {
  assert.equal(shouldAskPermission({ denied: false, userAction: false }), true); // first use, or Anki was not running
  assert.equal(shouldAskPermission({ denied: true, userAction: false }), false); // tab events, bubble clicks
  assert.equal(shouldAskPermission({ denied: true, userAction: true }), true); // "Connect to Anki", "+"
  assert.equal(shouldAskPermission({ denied: false, userAction: true }), true);
});

test("the explanation mode only becomes own once a key is saved", () => {
  const free = { mode: "free", apiKey: "" };
  assert.equal(llmModeAfter("open_own_key", free), "free");
  assert.equal(llmModeAfter("select_own", free), "free"); // no key yet
  assert.equal(llmModeAfter("select_own", { mode: "free", apiKey: "sk-x" }), "own");
  assert.equal(llmModeAfter("save_own", free), "own");
  assert.equal(llmModeAfter("select_free", { mode: "own", apiKey: "sk-x" }), "free");
  assert.equal(llmModeAfter("save_own_refused", free), "free");
  assert.equal(llmModeAfter("save_own_refused", { mode: "own", apiKey: "sk-x" }), "own");
});

test("Off is a mode of its own; deleting the key never switches to the free server", () => {
  assert.equal(llmModeAfter("select_off", { mode: "free", apiKey: "" }), "off");
  assert.equal(llmModeAfter("select_off", { mode: "own", apiKey: "sk-x" }), "off");
  assert.equal(llmModeAfter("select_free", { mode: "off", apiKey: "" }), "free");
  assert.equal(llmModeAfter("select_own", { mode: "off", apiKey: "" }), "off"); // no key yet: stays off
  assert.equal(llmModeAfter("select_own", { mode: "off", apiKey: "sk-x" }), "own");
  assert.equal(llmModeAfter("save_own", { mode: "off", apiKey: "" }), "own");
  assert.equal(llmModeAfter("delete_key", { mode: "own", apiKey: "sk-x" }), "off");
  assert.equal(llmModeAfter("delete_key", { mode: "free", apiKey: "sk-x" }), "free");
  assert.equal(llmModeAfter("delete_key", { mode: "off", apiKey: "sk-x" }), "off");
});

test("the hint under Explanations says where the text goes in each mode", () => {
  assert.equal(
    explanationsHint("free"),
    "The text of the bubble you click, a random install ID and the prompt version go to the project's server, which asks DeepSeek. The server also sees your network address (for the daily limit). Page images are not uploaded.",
  );
  assert.equal(explanationsHint("own"), "The text of the bubble you click goes from your browser to your provider, with your API key. Page images are not uploaded.");
  assert.equal(explanationsHint("off"), "Nothing is sent. Reading, the dictionary and cards work without explanations.");
  assert.equal(explanationsHint("anything else"), explanationsHint("free"));
});

test("explanations_off has its own message and no side effects", () => {
  assert.deepEqual(explainErrorMessage("explanations_off"), { text: "Explanations are off. Turn them on in Settings → Explanations.", action: null });
  assert.equal(freeRemainingAfterError("explanations_off"), null);
});

test("custom base URLs: https, or http only for localhost", () => {
  assert.deepEqual(validateBaseUrl(" https://api.example.com/v1 "), { ok: true, origin: "https://api.example.com", baseUrl: "https://api.example.com/v1" });
  for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1"]) {
    assert.equal(validateBaseUrl(u).ok, true, u);
  }
  assert.deepEqual(validateBaseUrl("http://localhost:11434/v1").origin, "http://localhost:11434");
  const insecure = { ok: false, error: "Use an https:// base URL (http:// is only allowed for localhost)." };
  assert.deepEqual(validateBaseUrl("http://api.example.com/v1"), insecure);
  assert.deepEqual(validateBaseUrl("http://localhost.evil.example/v1"), insecure);
  const garbage = { ok: false, error: "Enter the provider's base URL, e.g. https://api.example.com/v1." };
  for (const u of ["", "not a url", "ftp://example.com", "javascript:alert(1)", "//example.com"]) {
    assert.deepEqual(validateBaseUrl(u), garbage, u);
  }
});

test("a free-tier limit answer sets the 'left today' count to 0", () => {
  assert.equal(freeRemainingAfterError("free_daily_limit"), 0);
  assert.equal(freeRemainingAfterError("free_monthly_cap"), 0);
  assert.equal(freeRemainingAfterError("free_unavailable"), null);
  assert.equal(freeRemainingAfterError("auth"), null);
});

test("waitForBubbleText polls while the bubble is still being read, then returns the text", async () => {
  const replies = [{ ok: false, error: "text_pending" }, { ok: false, error: "text_pending" }, { ok: true, text: "あ" }];
  let calls = 0;
  const slept = [];
  const b = await waitForBubbleText(async () => replies[calls++], { intervalMs: 500, timeoutMs: 10000, sleep: async (ms) => void slept.push(ms) });
  assert.deepEqual(b, { ok: true, text: "あ" });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [500, 500]);
});

test("waitForBubbleText gives up after the timeout with the pending reply, and stops at other errors", async () => {
  let t = 0;
  const pending = await waitForBubbleText(async () => ({ ok: false, error: "text_pending" }), { intervalMs: 1000, timeoutMs: 3000, sleep: async (ms) => void (t += ms), now: () => t });
  assert.deepEqual(pending, { ok: false, error: "text_pending" });
  assert.ok(t >= 3000 && t <= 4000);
  let n = 0;
  const other = await waitForBubbleText(async () => (n++, { ok: false, error: "unknown_bubble" }), { sleep: async () => {} });
  assert.deepEqual(other, { ok: false, error: "unknown_bubble" });
  assert.equal(n, 1);
});

test("the monthly-cap message names the 1st of next month in UTC, across year wrap and month ends", () => {
  const on = (iso) => explainErrorMessage("free_monthly_cap", { now: new Date(iso) });
  const back = (date) => `The free service has used its budget for this month; it comes back on ${date}. You can add your own API key in Settings.`;
  assert.equal(on("2026-11-08T10:00:00Z").text, back("December 1"));
  assert.equal(on("2026-12-15T10:00:00Z").text, back("January 1"));
  // the last UTC evening of a month is still that month, even where the local date is already the next
  assert.equal(on("2026-11-30T23:59:59Z").text, back("December 1"));
  assert.equal(on("2026-12-31T23:30:00Z").text, back("January 1"));
  assert.equal(on("2026-11-01T00:00:00Z").text, back("December 1"));
  assert.equal(on("2026-11-08T10:00:00Z").action, "own_key");
  assert.match(explainErrorMessage("free_monthly_cap").text, /it comes back on [A-Z][a-z]+ 1\./, "now defaults to the current time");
});

test("a card added just now reads as success; one already in the deck stays quiet", () => {
  assert.deepEqual(cardDoneState("added"), { label: "✓ added", cls: "added" });
  assert.deepEqual(cardDoneState("in_deck"), { label: "✓ in deck", cls: "have" });
});

test("a declined line: neutral message, no retry, and the free counter is left alone", () => {
  const own = explainErrorMessage("refused");
  assert.deepEqual(own, { text: "No explanation for this line: the model declined it. The text, readings and dictionary still work.", action: null });
  const free = explainErrorMessage("refused", { free: true });
  assert.equal(free.action, null);
  assert.equal(free.text, `${own.text} It did not count toward your free limit.`);
  assert.equal(explainErrorMessage("free_daily_limit", { free: true }).text, explainErrorMessage("free_daily_limit").text, "other codes ignore the mode");
  assert.equal(freeRemainingAfterError("refused"), null);
});

test("deck: a deck that Anki has is selected as it is, with nothing to offer", () => {
  assert.deepEqual(deckChoice(["Default", "Japanese", "manga mining"], "Japanese"), { selected: "Japanese", offer: null });
});

test("deck: no deck and 'manga mining' exists: preselected, but only saved once the user confirms", () => {
  assert.equal(DEFAULT_DECK, "manga mining");
  assert.deepEqual(deckChoice(["Default", "manga mining"], null), { selected: "manga mining", offer: "use" });
});

test("deck: no deck and no 'manga mining': nothing is selected (never the first deck); creating it is offered", () => {
  assert.deepEqual(deckChoice(["Default", "Japanese"], null), { selected: null, offer: "create" });
  assert.deepEqual(deckChoice([], null), { selected: null, offer: "create" });
});

test("resolveDeck: the deck of this site wins while Anki has it", () => {
  const decks = { "https://a.example": "Site", _last: "Last" };
  assert.deepEqual(resolveDeck(decks, "https://a.example", ["Last", "Site"]), { deck: "Site", missing: null });
});

test("resolveDeck: a site deck Anki lacks falls back to the last deck, and is reported", () => {
  const decks = { "https://a.example": "Site", _last: "Last" };
  assert.deepEqual(resolveDeck(decks, "https://a.example", ["Last"]), { deck: "Last", missing: "Site" });
});

test("resolveDeck: a lacking last deck is not reported while the site deck is fine", () => {
  const decks = { "https://a.example": "Site", _last: "Other site's deck" };
  assert.deepEqual(resolveDeck(decks, "https://a.example", ["Site"]), { deck: "Site", missing: null });
});

test("resolveDeck: both decks missing: no deck, the site deck is reported", () => {
  const decks = { "https://a.example": "Site", _last: "Last" };
  assert.deepEqual(resolveDeck(decks, "https://a.example", ["Default"]), { deck: null, missing: "Site" });
});

test("resolveDeck: a site without its own deck uses the last one, or reports it when Anki lacks it", () => {
  const decks = { _last: "Last" };
  assert.deepEqual(resolveDeck(decks, "https://b.example", ["Last"]), { deck: "Last", missing: null });
  assert.deepEqual(resolveDeck(decks, "https://b.example", ["Default"]), { deck: null, missing: "Last" });
  assert.deepEqual(resolveDeck(decks, null, ["Last"]), { deck: "Last", missing: null });
});

test("resolveDeck: an empty list of names yields no deck, and the function leaves the saved decks alone", () => {
  const decks = { "https://a.example": "Site", _last: "Site" };
  const before = JSON.stringify(decks);
  assert.deepEqual(resolveDeck(decks, "https://a.example", []), { deck: null, missing: "Site" });
  assert.equal(JSON.stringify(decks), before);
});

test("resolveDeck: nothing saved: no deck, nothing reported", () => {
  assert.deepEqual(resolveDeck({}, "https://a.example", ["Default", "manga mining"]), { deck: null, missing: null });
  assert.deepEqual(resolveDeck(undefined, null, []), { deck: null, missing: null });
});

test("deckForCard: the last successful check decides for this site; without one, storage is read as it is", () => {
  const decks = { "https://a.example": "Site", _last: "Last" };
  assert.equal(deckForCard(decks, "https://a.example", { origin: "https://a.example", deck: null }), null, "checked: nothing usable");
  assert.equal(deckForCard(decks, "https://a.example", { origin: "https://a.example", deck: "Last" }), "Last");
  assert.equal(deckForCard(decks, "https://a.example", { origin: "https://other.example", deck: "X" }), "Site", "a check of another site does not count");
  assert.equal(deckForCard(decks, "https://a.example", null), "Site");
  assert.equal(deckForCard({ _last: "Last" }, "https://b.example", null), "Last");
  assert.equal(deckForCard({}, "https://b.example", null), null);
});

test("deckChanged: announced when the deck in force differs from the last one announced", () => {
  let announced = null; // nothing announced yet
  const load = (deck) => {
    const fires = deckChanged(announced, deck);
    if (fires) announced = deck;
    return fires;
  };
  assert.equal(load(null), false, "first load, no deck: nothing to refresh");
  assert.equal(load("manga mining"), true, "the user picks, confirms or creates a deck");
  assert.equal(load("manga mining"), false, "the same deck again");
  assert.equal(load("Japanese"), true, "a tab change to a site with another deck");
  assert.equal(load(null), true, "the deck is gone");
});

test("latestCall: only the newest call is current", () => {
  const next = latestCall();
  const first = next();
  assert.equal(first(), true);
  const second = next();
  assert.equal(first(), false, "an older call no longer paints");
  assert.equal(second(), true);
});

test("deck: the line by the cards names the target deck, or says to pick one", () => {
  assert.equal(deckTargetText("manga mining"), "Cards go to → manga mining");
  assert.equal(deckTargetText(null), NO_DECK);
  assert.equal(NO_DECK, "Pick an Anki deck in Settings first.");
});

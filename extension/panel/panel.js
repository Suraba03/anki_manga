import { callJson, ensurePaired, health, HelperError } from "../lib/helper-client.js";

const $ = (id) => document.getElementById(id);

export const MESSAGES = {
  helper_unreachable: "Helper not running — start it with: anki-manga-helper",
  warming: "Loading OCR models…",
  no_api_key: "Add your DeepSeek API key in Settings to get explanations.",
  auth: "DeepSeek rejected the API key — check it in Settings.",
  bad_response: "Explanation failed — click the bubble again to retry.",
  anki_unreachable: "Anki isn't running — open Anki with AnkiConnect to add cards.",
  page_expired: "This page is no longer cached — scroll back to it and try again.",
};

const state = { origin: null, tabId: null, ready: false };

function setStatus(kind, text) {
  $("status").dataset.state = kind;
  $("status").textContent = text;
}

function showBanner(html) {
  $("banner").hidden = !html;
  $("banner").innerHTML = html || "";
}

// --- helper connection --------------------------------------------------------
async function connect() {
  try {
    const h = await health();
    const paired = await ensurePaired();
    if (!paired.ok) {
      if (paired.error === "already_paired") {
        setStatus("pairing", "Not paired");
        showBanner(
          "This helper is paired with another install of the extension. In a terminal run <code>anki-manga-helper --reset-pairing</code>, then restart the helper and reopen this panel.",
        );
      } else {
        setStatus("down", "Helper not running");
        showBanner(`${MESSAGES.helper_unreachable}`);
      }
      state.ready = false;
      return;
    }
    showBanner("");
    state.ready = true;
    if (h.status === "ready") setStatus("ready", "Helper ready");
    else setStatus("warming", MESSAGES.warming);
    $("key-state").textContent = h.has_api_key ? "Key saved." : "No key yet.";
    if (h.status !== "ready") setTimeout(connect, 3000);
  } catch {
    state.ready = false;
    setStatus("down", "Helper not running");
    showBanner(MESSAGES.helper_unreachable);
    setTimeout(connect, 5000);
  }
}

// --- site toggle ----------------------------------------------------------------
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshSite() {
  const tab = await currentTab();
  let origin = null;
  try {
    const url = new URL(tab.url);
    if (url.protocol === "http:" || url.protocol === "https:") origin = url.origin;
  } catch {
    /* chrome:// etc. */
  }
  state.origin = origin;
  state.tabId = tab ? tab.id : null;
  $("site-name").textContent = origin ? new URL(origin).host : "This page can't be used";
  const enabled = ((await chrome.storage.local.get("enabledOrigins")).enabledOrigins || []).includes(origin);
  $("site-toggle").disabled = !origin;
  $("site-toggle").textContent = enabled ? "Disable on this site" : "Enable on this site";
  $("site-toggle").dataset.enabled = enabled ? "1" : "";
  await loadDecks();
}

$("site-toggle").addEventListener("click", async () => {
  const { origin, tabId } = state;
  if (!origin) return;
  if ($("site-toggle").dataset.enabled) {
    await chrome.runtime.sendMessage({ type: "am:disable-site", origin, tabId });
  } else {
    // Must run inside the click handler (user gesture).
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return;
    await chrome.runtime.sendMessage({ type: "am:enable-site", origin, tabId });
  }
  await refreshSite();
});

// --- settings ---------------------------------------------------------------------
$("save-key").addEventListener("click", async () => {
  const key = $("api-key").value.trim();
  if (!key) return;
  try {
    await callJson("/settings", { method: "PUT", json: { api_key: key } });
    $("api-key").value = "";
    $("key-state").textContent = "Key saved.";
  } catch (e) {
    $("key-state").textContent = MESSAGES[e.error] || `Could not save (${e.error}).`;
  }
});

export async function currentDeck() {
  const decks = (await chrome.storage.local.get("decks")).decks || {};
  return (state.origin && decks[state.origin]) || decks._last || null;
}

async function loadDecks() {
  const select = $("deck");
  try {
    const { decks } = await callJson("/anki/decks");
    const chosen = (await currentDeck()) || (decks.includes("manga mining") ? "manga mining" : decks[0]);
    select.replaceChildren(...decks.map((d) => new Option(d, d, false, d === chosen)));
    $("deck-state").textContent = "";
    if (chosen) await saveDeck(chosen);
  } catch (e) {
    $("deck-state").textContent = MESSAGES[e.error] || "Could not load decks.";
  }
}

async function saveDeck(deck) {
  const decks = (await chrome.storage.local.get("decks")).decks || {};
  if (state.origin) decks[state.origin] = deck;
  decks._last = deck;
  await chrome.storage.local.set({ decks });
  callJson("/anki/refresh", { method: "POST", json: { deck } }).catch(() => {});
}

$("deck").addEventListener("change", () => saveDeck($("deck").value));

chrome.tabs.onActivated.addListener(refreshSite);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === state.tabId && info.url) refreshSite();
});

export { state, HelperError };

await connect();
await refreshSite();

// The settings drawer: deck, explanation source (free / own key), text-recognition mode, delete data.
import { getSettings, setSettings } from "../lib/settings.js";
import { freeLeftText, ankiErrorMessage } from "./logic.js";
import { deckNames, forgetKnown } from "./anki.js";
import { engine } from "./engine.js";
import { state } from "./state.js";

const $ = (id) => document.getElementById(id);

// --- deck ---------------------------------------------------------------------------
export async function currentDeck() {
  const decks = (await chrome.storage.local.get("decks")).decks || {};
  return (state.origin && decks[state.origin]) || decks._last || null;
}

async function saveDeck(deck) {
  const decks = (await chrome.storage.local.get("decks")).decks || {};
  if (state.origin) decks[state.origin] = deck;
  decks._last = deck;
  await chrome.storage.local.set({ decks });
}

export async function loadDecks() {
  const select = $("deck");
  try {
    const names = await deckNames();
    const chosen = (await currentDeck()) || (names.includes("manga mining") ? "manga mining" : names[0]);
    select.replaceChildren(...names.map((d) => new Option(d, d, false, d === chosen)));
    $("deck-state").textContent = "";
    if (chosen) await saveDeck(chosen);
  } catch (e) {
    $("deck-state").textContent = ankiErrorMessage(e.kind || "anki_error", e.kind ? "" : e.message);
  }
}

// --- explanations: free or own key ----------------------------------------------------
async function showLlm() {
  const { llm } = await getSettings();
  document.querySelector(`input[name="llm-mode"][value="${llm.mode}"]`).checked = true;
  $("own-key").hidden = llm.mode !== "own";
  $("provider").value = llm.provider;
  $("base-url-field").hidden = llm.provider !== "custom";
  $("base-url").value = llm.baseUrl;
  $("model").value = llm.model;
  $("api-key").placeholder = llm.apiKey ? "Key saved — paste a new one to replace it" : "sk-…";
}

async function showFreeLeft() {
  const { freeRemaining = null } = await chrome.storage.session.get("freeRemaining");
  $("free-left").textContent = freeLeftText(freeRemaining);
}

async function saveOwn() {
  const settings = await getSettings();
  const provider = $("provider").value;
  const key = $("api-key").value.trim() || settings.llm.apiKey;
  const baseUrl = $("base-url").value.trim();
  const model = $("model").value.trim();
  if (!key) {
    $("own-state").textContent = "Paste your API key first.";
    return;
  }
  if (provider === "custom") {
    let origin;
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      origin = u.origin;
    } catch {
      $("own-state").textContent = "Enter the provider's base URL, e.g. https://api.example.com/v1.";
      return;
    }
    // Still inside the click handler: the permission prompt needs the user gesture, so nothing is awaited before it.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      $("own-state").textContent = `Not saved: the extension needs permission to contact ${new URL(origin).host}.`;
      return;
    }
  }
  await setSettings({ llm: { provider, apiKey: key, baseUrl: provider === "custom" ? baseUrl : "", model } });
  $("api-key").value = "";
  $("own-state").textContent = "Saved.";
  showLlm();
}

// "Add your own API key" in an error message: open the settings with the own-key form.
export async function openOwnKey() {
  await setSettings({ llm: { mode: "own" } });
  await showLlm();
  $("settings").open = true;
  $("settings").scrollIntoView();
}

export async function initSettings() {
  $("deck").addEventListener("change", () => {
    saveDeck($("deck").value);
    forgetKnown($("deck").value);
  });
  for (const radio of document.querySelectorAll('input[name="llm-mode"]')) {
    radio.addEventListener("change", async () => {
      await setSettings({ llm: { mode: radio.value } });
      showLlm();
    });
  }
  $("provider").addEventListener("change", () => {
    $("base-url-field").hidden = $("provider").value !== "custom";
  });
  $("save-own").addEventListener("click", saveOwn);

  $("perf").value = (await getSettings()).perfMode;
  $("perf").addEventListener("change", () => setSettings({ perfMode: $("perf").value }));

  $("clear-models").addEventListener("click", async () => {
    if (!confirm("Delete the downloaded models, the dictionary and all cached pages and explanations? They download again when needed.")) return;
    const r = await engine({ type: "eng:clear" });
    $("clear-state").textContent = r.ok ? "Deleted." : "Could not delete (engine not running).";
  });

  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.freeRemaining) showFreeLeft();
  });
  await showLlm();
  await showFreeLeft();
}

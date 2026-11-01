// The settings drawer: deck, explanation source (free / own key), text-recognition mode, delete data.
import { getSettings, setSettings } from "../lib/settings.js";
import { freeLeftText, ankiErrorMessage, ownKeyCheck, llmModeAfter, validateBaseUrl } from "./logic.js";
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

// userAction: true from the "Connect to Anki" button; events (tab changes) never re-ask after a denial.
export async function loadDecks({ userAction = false } = {}) {
  const select = $("deck");
  try {
    const names = await deckNames({ userAction });
    $("anki-connect").hidden = true;
    const chosen = (await currentDeck()) || (names.includes("manga mining") ? "manga mining" : names[0]);
    select.replaceChildren(...names.map((d) => new Option(d, d, false, d === chosen)));
    $("deck-state").textContent = "";
    if (chosen) await saveDeck(chosen);
  } catch (e) {
    $("deck-state").textContent = ankiErrorMessage(e.kind || "anki_error", e.kind ? "" : e.message);
    $("anki-connect").hidden = false;
  }
}

// --- explanations: free or own key ----------------------------------------------------
// The own-key form can be open while the saved mode is still "free": the mode flips when a key is saved.
let ownFormOpen = false;

async function showLlm() {
  const { llm } = await getSettings();
  const showOwn = llm.mode === "own" || ownFormOpen;
  document.querySelector(`input[name="llm-mode"][value="${showOwn ? "own" : "free"}"]`).checked = true;
  $("own-key").hidden = !showOwn;
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
  const { llm } = await getSettings();
  const provider = $("provider").value;
  const say = (text) => {
    $("own-state").textContent = text;
  };
  const baseInput = $("base-url").value.trim();
  const checked = ownKeyCheck(llm, { provider, baseUrl: baseInput, typedKey: $("api-key").value });
  let origin = null;
  if (provider === "custom") {
    const url = validateBaseUrl(baseInput);
    if (!url.ok) return say(url.error);
    origin = url.origin;
  }
  if (!checked.ok) return say(checked.error);
  // Still inside the click handler: the permission prompt needs the user gesture, so nothing is awaited before it.
  if (origin && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
    return say(`Not saved: the extension needs permission to contact ${new URL(origin).host}.`);
  }
  await setSettings({
    llm: {
      mode: llmModeAfter("save_own", llm),
      provider,
      apiKey: checked.key,
      baseUrl: provider === "custom" ? baseInput : "",
      model: $("model").value.trim(),
    },
  });
  ownFormOpen = false;
  $("api-key").value = "";
  say("Saved.");
  showLlm();
}

// "Add your own API key" in an error message: open the settings with the own-key form.
export async function openOwnKey() {
  ownFormOpen = true; // the mode stays "free" until a key is saved
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
      const { llm } = await getSettings();
      ownFormOpen = radio.value === "own";
      const mode = llmModeAfter(radio.value === "own" ? "select_own" : "select_free", llm);
      if (mode !== llm.mode) await setSettings({ llm: { mode } });
      showLlm();
    });
  }
  $("provider").addEventListener("change", () => {
    $("base-url-field").hidden = $("provider").value !== "custom";
  });
  $("save-own").addEventListener("click", saveOwn);
  $("anki-connect").addEventListener("click", () => loadDecks({ userAction: true }));

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

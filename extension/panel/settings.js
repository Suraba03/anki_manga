// The settings drawer: deck, explanation source (free / own key), text-recognition mode, delete data.
import { getSettings, setSettings } from "../lib/settings.js";
import { freeLeftText, ankiErrorMessage, ownKeyCheck, llmModeAfter, validateBaseUrl, resolveDeck, deckChoice, deckForCard, deckTargetText, latestCall, deckChanged, DEFAULT_DECK } from "./logic.js";
import { deckNames, createDeck, forgetKnown } from "./anki.js";
import { engine } from "./engine.js";
import { state } from "./state.js";

const $ = (id) => document.getElementById(id);

// --- deck ---------------------------------------------------------------------------
const savedDecks = async () => (await chrome.storage.local.get("decks")).decks || {};

// The deck "+" and the deck line use: what the last look at Anki's deck list found for this site, or, before one,
// what is saved. Nothing is ever deleted from storage because Anki's list lacks a deck.
export async function currentDeck() {
  return deckForCard(await savedDecks(), state.origin, state.deckChecked);
}

async function saveDeck(deck) {
  const decks = await savedDecks();
  if (state.origin) decks[state.origin] = deck;
  decks._last = deck;
  await chrome.storage.local.set({ decks });
}

// The line above the entries: where cards go, or that a deck must be picked first.
export async function showDeckTarget() {
  const deck = await currentDeck();
  $("deck-target").textContent = deckTargetText(deck);
  $("deck-target").classList.toggle("none", !deck);
}

async function chooseDeck(deck) {
  await saveDeck(deck);
  state.deckChecked = { origin: state.origin, deck }; // the user just picked it from Anki's own list, or created it
  forgetKnown(deck);
  await loadDecks();
}

// Entries already on screen grey out the words the new deck has (entries.js listens).
export const DECK_CHANGED = "am:deck-changed";

const nextDeckLoad = latestCall();
let announcedDeck = null; // the deck the entries on screen were last told about (not state.deckChecked, which chooseDeck sets early)

// userAction: true from the "Connect to Anki" button; events (tab changes) never re-ask after a denial.
// Nothing is saved here: see resolveDeck and deckChoice. A deck is saved only when the user picks one, confirms or
// creates it. Overlapping calls (a tab change during a click): only the newest paints.
export async function loadDecks({ userAction = false } = {}) {
  const isCurrent = nextDeckLoad();
  const select = $("deck");
  try {
    const names = await deckNames({ userAction });
    const decks = await savedDecks();
    if (!isCurrent()) return;
    const { deck, missing } = resolveDeck(decks, state.origin, names);
    const choice = deckChoice(names, deck);
    state.deckChecked = { origin: state.origin, deck };
    $("anki-connect").hidden = true;
    const options = names.map((d) => new Option(d, d, false, d === choice.selected));
    if (!choice.selected) options.unshift(Object.assign(new Option("Choose a deck…", "", true, true), { disabled: true }));
    select.replaceChildren(...options);
    $("deck-use").hidden = choice.offer !== "use";
    if (choice.offer === "use") $("deck-use").textContent = `Use “${choice.selected}”`;
    $("deck-create").hidden = choice.offer !== "create";
    const gone = missing ? `“${missing}” is no longer in Anki. ` : "";
    $("deck-state").textContent =
      choice.offer === "use" ? `${gone}Cards will go to “${DEFAULT_DECK}” once you confirm it.`
      : choice.offer === "create" ? `${gone}Choose a deck for your cards, or create “${DEFAULT_DECK}”.`
      : gone ? `${gone}Cards go to “${deck}”.`
      : "";
    await showDeckTarget();
    if (isCurrent() && deckChanged(announcedDeck, deck)) {
      announcedDeck = deck;
      document.dispatchEvent(new Event(DECK_CHANGED));
    }
  } catch (e) {
    if (!isCurrent()) return;
    $("deck-state").textContent = ankiErrorMessage(e.kind || "anki_error", e.kind ? "" : e.message);
    $("deck-use").hidden = true;
    $("deck-create").hidden = true;
    $("anki-connect").hidden = false;
    await showDeckTarget();
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
    if ($("deck").value) chooseDeck($("deck").value);
  });
  $("deck-use").addEventListener("click", () => chooseDeck(DEFAULT_DECK));
  $("deck-create").addEventListener("click", async () => {
    $("deck-create").disabled = true;
    try {
      await createDeck(DEFAULT_DECK);
      await chooseDeck(DEFAULT_DECK);
    } catch (e) {
      $("deck-state").textContent = ankiErrorMessage(e.kind || "anki_error", e.kind ? "" : e.message);
    } finally {
      $("deck-create").disabled = false;
    }
  });
  $("deck-target").addEventListener("click", () => {
    $("settings").open = true;
    $("deck").focus();
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

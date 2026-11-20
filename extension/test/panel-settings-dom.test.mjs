// panel/settings.js against a small fake DOM, fake chrome.* storage and a fake AnkiConnect (no jsdom in this repo).
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake DOM: just what settings.js touches ----
class FakeEl {
  constructor(id) {
    Object.assign(this, { id, hidden: false, disabled: false, textContent: "", value: "", checked: false, placeholder: "", open: false, options: [], listeners: {} });
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  async click() {
    await Promise.all((this.listeners.click || []).map((fn) => fn({ target: this })));
  }
  async change() {
    await Promise.all((this.listeners.change || []).map((fn) => fn({ target: this })));
  }
  replaceChildren(...options) {
    this.options = options;
    const picked = [...options].reverse().find((o) => o.selected) ?? options[0];
    this.value = picked ? picked.value : "";
  }
  get classList() {
    const set = (this._classes ||= new Set());
    return { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) };
  }
  focus() {}
  scrollIntoView() {}
}
globalThis.Option = class {
  constructor(text, value, defaultSelected, selected) {
    Object.assign(this, { text, value, defaultSelected, selected, disabled: false });
  }
};

const IDS = ["deck", "deck-use", "deck-create", "deck-state", "deck-target", "anki-connect", "settings", "provider", "base-url-field", "base-url", "model", "api-key",
  "llm-hint", "free-left", "delete-key", "own-key", "own-state", "llm-state", "save-own", "perf", "clear-models", "clear-state"];
let els;
let radios;
let docListeners;
function resetDom() {
  els = Object.fromEntries(IDS.map((id) => [id, new FakeEl(id)]));
  radios = ["free", "own", "off"].map((v) => Object.assign(new FakeEl(`llm-${v}`), { value: v }));
  docListeners = {};
}
globalThis.document = {
  getElementById: (id) => els[id],
  querySelector: (sel) => {
    const m = sel.match(/value="(\w+)"/);
    return m ? radios.find((r) => r.value === m[1]) : radios.find((r) => r.checked);
  },
  querySelectorAll: () => radios,
  addEventListener: (type, fn) => (docListeners[type] ||= []).push(fn),
  dispatchEvent: (ev) => (docListeners[ev.type] || []).forEach((fn) => fn(ev)),
};

// ---- fake chrome.storage and AnkiConnect ----
let local;
let session;
let anki; // {decks: [...], down: bool}
let calls;
function resetWorld(over = {}) {
  local = { settings: { installId: "00000000-0000-4000-8000-000000000000" }, ...over.local };
  session = {};
  anki = { decks: ["Default", "manga mining", "Core"], down: false, ...over.anki };
  calls = [];
}
const store = (area) => ({
  get: async (key) => (typeof key === "string" ? (key in area ? { [key]: structuredClone(area[key]) } : {}) : {}),
  set: async (obj) => void Object.assign(area, structuredClone(obj)),
});
globalThis.chrome = {
  storage: { local: store({}), session: { ...store({}), onChanged: { addListener() {} } } },
  permissions: { request: async () => true },
};
const bindStorage = () => {
  chrome.storage.local = store(local);
  chrome.storage.session = { ...store(session), onChanged: { addListener() {} } };
};
globalThis.confirm = () => true;
globalThis.fetch = async (url, init) => {
  const { action, params } = JSON.parse(init.body);
  calls.push(action);
  if (anki.down) throw new TypeError("Failed to fetch");
  const ok = (result) => Response.json({ result, error: null });
  if (action === "requestPermission") return ok({ permission: "granted" });
  if (action === "deckNames") return ok([...anki.decks]);
  if (action === "createDeck") return (anki.decks.push(params.deck), ok(1));
  return Response.json({ result: null, error: `unexpected ${action}` });
};

// A fresh copy of the module per test: its state (announced deck, "no longer in Anki" memory) starts clean.
let n = 0;
const load = async () => {
  const { state } = await import("../panel/state.js");
  Object.assign(state, { origin: "https://manga.test", tabId: 1, deckChecked: null });
  const mod = await import(`../panel/settings.js?t=${++n}`);
  return { mod, state };
};
const decksSaved = () => local.decks;
// The picker's listener starts chooseDeck without returning it: let it and the reload it triggers finish.
const settle = () => new Promise((r) => setTimeout(r, 20));
beforeEach(() => {
  resetDom();
  resetWorld();
  bindStorage();
});

test("no saved deck, no 'manga mining': offers to create it; nothing is saved", async () => {
  resetWorld({ anki: { decks: ["Default", "Core"] } });
  bindStorage();
  const { mod } = await load();
  await mod.loadDecks();
  assert.equal(els["deck-create"].hidden, false);
  assert.equal(els["deck-use"].hidden, true);
  assert.equal(els["deck-state"].textContent, "Choose a deck for your cards, or create “manga mining”.");
  assert.equal(els["deck"].options[0].text, "Choose a deck…");
  assert.equal(els["deck"].value, "", "nothing preselected");
  assert.equal(els["deck-target"].textContent, "Pick an Anki deck in Settings first.");
  assert.equal(els["deck-target"].classList.contains("none"), true);
  assert.equal(decksSaved(), undefined, "a deck is saved only when the user picks one");
  assert.equal(els["anki-connect"].hidden, true);
});

test("no saved deck but 'manga mining' exists: preselected, offered as 'Use', still nothing saved", async () => {
  const { mod } = await load();
  await mod.loadDecks();
  assert.equal(els["deck-use"].hidden, false);
  assert.equal(els["deck-use"].textContent, "Use “manga mining”");
  assert.equal(els["deck-create"].hidden, true);
  assert.equal(els["deck"].value, "manga mining");
  assert.equal(els["deck-state"].textContent, "Cards will go to “manga mining” once you confirm it.");
  assert.equal(decksSaved(), undefined);
});

test("a saved deck Anki has: selected, no offer, the deck line names it", async () => {
  resetWorld({ local: { decks: { "https://manga.test": "Core", _last: "Core" } } });
  bindStorage();
  const { mod } = await load();
  await mod.loadDecks();
  assert.equal(els["deck"].value, "Core");
  assert.equal(els["deck-use"].hidden, true);
  assert.equal(els["deck-create"].hidden, true);
  assert.equal(els["deck-state"].textContent, "");
  assert.equal(els["deck-target"].textContent, "Cards go to → Core");
  assert.equal(els["deck-target"].classList.contains("none"), false);
});

test("a saved deck Anki lacks is named once; the saved entry is kept; later looks stay quiet", async () => {
  resetWorld({ local: { decks: { "https://manga.test": "Old", _last: "Old" } } });
  bindStorage();
  const { mod } = await load();
  await mod.loadDecks();
  assert.equal(els["deck-state"].textContent, "“Old” is no longer in Anki. Cards will go to “manga mining” once you confirm it.");
  await mod.loadDecks(); // a tab change
  assert.equal(els["deck-state"].textContent, "Cards will go to “manga mining” once you confirm it.", "said once");
  assert.deepEqual(decksSaved(), { "https://manga.test": "Old", _last: "Old" }, "never deleted from storage");
});

test("picking a deck saves it for the site and as the last one, and the new line is shown", async () => {
  const { mod } = await load();
  await mod.initSettings();
  await mod.loadDecks();
  els["deck"].value = "Core";
  await els["deck"].change();
  await settle();
  assert.deepEqual(decksSaved(), { "https://manga.test": "Core", _last: "Core" });
  assert.equal(els["deck-target"].textContent, "Cards go to → Core");
  assert.equal(els["deck-use"].hidden, true);
});

test("'Use manga mining' confirms the preselected deck", async () => {
  const { mod } = await load();
  await mod.initSettings();
  await mod.loadDecks();
  await els["deck-use"].click();
  assert.equal(decksSaved()._last, "manga mining");
  assert.equal(els["deck-target"].textContent, "Cards go to → manga mining");
});

test("'Create manga mining' creates it in Anki and then saves it", async () => {
  resetWorld({ anki: { decks: ["Default"] } });
  bindStorage();
  const { mod } = await load();
  await mod.initSettings();
  await mod.loadDecks();
  await els["deck-create"].click();
  assert.ok(calls.includes("createDeck"));
  assert.deepEqual(anki.decks.sort(), ["Default", "manga mining"]);
  assert.equal(decksSaved()._last, "manga mining");
  assert.equal(els["deck-create"].disabled, false, "the button is released");
  assert.equal(els["deck-create"].hidden, true);
});

test("Anki not running: the message, the Connect button, no offers", async () => {
  resetWorld({ anki: { down: true } });
  bindStorage();
  const { mod } = await load();
  await mod.loadDecks();
  assert.equal(els["deck-state"].textContent, "Anki isn't running — open Anki with AnkiConnect to add cards.");
  assert.equal(els["anki-connect"].hidden, false);
  assert.equal(els["deck-use"].hidden, true);
  assert.equal(els["deck-create"].hidden, true);
});

test("DECK_CHANGED fires when the deck in force changes, not on a repeated look", async () => {
  const { mod } = await load();
  let fired = 0;
  document.addEventListener(mod.DECK_CHANGED, () => fired++);
  await mod.initSettings();
  await mod.loadDecks(); // none in force yet: null -> null is no change
  assert.equal(fired, 0);
  els["deck"].value = "Core";
  await els["deck"].change(); // chosen: null -> Core
  await settle();
  assert.equal(fired, 1);
  await mod.loadDecks(); // Core -> Core
  assert.equal(fired, 1);
  els["deck"].value = "Default";
  await els["deck"].change();
  await settle();
  assert.equal(fired, 2);
});

test("the deck line is a button: it opens Settings and focuses the picker", async () => {
  const { mod } = await load();
  await mod.initSettings();
  await els["deck-target"].click();
  assert.equal(els["settings"].open, true);
});

test("Explanations: Free is shown by default, with the count line; the hint says where text goes", async () => {
  const { mod } = await load();
  await mod.initSettings();
  assert.equal(radios.find((r) => r.value === "free").checked, true);
  assert.equal(els["free-left"].hidden, false);
  assert.equal(els["own-key"].hidden, true);
  assert.equal(els["delete-key"].hidden, true);
  assert.match(els["llm-hint"].textContent, /project's server/);
});

test("Explanations: choosing Off saves it, hides the count and changes the hint", async () => {
  const { mod } = await load();
  await mod.initSettings();
  const off = radios.find((r) => r.value === "off");
  off.checked = true;
  await off.change();
  assert.equal(local.settings.llm.mode, "off");
  assert.equal(els["free-left"].hidden, true);
  assert.match(els["llm-hint"].textContent, /No bubble text is sent/);
});

test("Explanations: Own key opens the form but the mode stays free until a key is saved", async () => {
  const { mod } = await load();
  await mod.initSettings();
  const own = radios.find((r) => r.value === "own");
  await own.change();
  assert.equal(els["own-key"].hidden, false);
  assert.equal((local.settings.llm || {}).mode ?? "free", "free");
  els["api-key"].value = "sk-test";
  await els["save-own"].click();
  assert.equal(local.settings.llm.mode, "own");
  assert.equal(local.settings.llm.apiKey, "sk-test");
  assert.equal(els["own-state"].textContent, "Saved.");
  assert.equal(els["delete-key"].hidden, false);
  assert.equal(els["api-key"].value, "", "the typed key is not left in the field");
});

test("Explanations: saving without any key says what is missing and saves nothing", async () => {
  const { mod } = await load();
  await mod.initSettings();
  await radios.find((r) => r.value === "own").change();
  await els["save-own"].click();
  assert.equal(els["own-state"].textContent, "Enter the API key for this provider.");
  assert.equal(local.settings.llm?.apiKey ?? "", "");
});

test("Explanations: deleting the saved key from Own turns explanations off, never to the free server", async () => {
  resetWorld({ local: { settings: { installId: "00000000-0000-4000-8000-000000000000", llm: { mode: "own", provider: "deepseek", apiKey: "sk-test", baseUrl: "", model: "" } } } });
  bindStorage();
  const { mod } = await load();
  await mod.initSettings();
  assert.equal(els["delete-key"].hidden, false);
  await els["delete-key"].click();
  assert.equal(local.settings.llm.apiKey, "");
  assert.equal(local.settings.llm.mode, "off");
  assert.equal(els["llm-state"].textContent, "Key deleted. Explanations are off until you choose Free or save a new key.");
  assert.equal(els["delete-key"].hidden, true);
});

test("the free count line follows the session value", async () => {
  session.freeRemaining = 42;
  const { mod } = await load();
  await mod.initSettings();
  assert.equal(els["free-left"].textContent, "42 left today");
});

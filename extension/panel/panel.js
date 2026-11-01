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
  await renderHostRequests();
  await loadDecks();
}

// Images often come from a CDN host; asking for it needs a click (user gesture).
async function renderHostRequests() {
  const { missingHosts = {} } = await chrome.storage.session.get("missingHosts");
  const hosts = state.tabId != null ? missingHosts[state.tabId] || [] : [];
  const buttons = [];
  for (const host of hosts) {
    if (await chrome.permissions.contains({ origins: [`*://${host}/*`] })) continue;
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = `Allow images from ${host}`;
    btn.addEventListener("click", async () => {
      if (!(await chrome.permissions.request({ origins: [`*://${host}/*`] }))) return;
      const { missingHosts: mh = {} } = await chrome.storage.session.get("missingHosts");
      mh[state.tabId] = (mh[state.tabId] || []).filter((h) => h !== host);
      await chrome.storage.session.set({ missingHosts: mh });
      chrome.tabs.sendMessage(state.tabId, { type: "am:retry" }).catch(() => {});
      renderHostRequests();
    });
    buttons.push(btn);
  }
  $("host-requests").replaceChildren(...buttons);
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.missingHosts) renderHostRequests();
});

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

// --- explaining a clicked bubble ---------------------------------------------------------
const MAX_ENTRIES = 30;
let lastShown = 0;

function message(error) {
  if (MESSAGES[error]) return MESSAGES[error];
  if (error === "network" || error === "deepseek" || /^http_5/.test(error)) return MESSAGES.bad_response;
  return `Something went wrong (${error}).`;
}

function showMsg(entry, text) {
  const box = entry.querySelector(".msg");
  box.hidden = !text;
  box.textContent = text || "";
}

function cardRow(s, sel, entry) {
  const row = document.createElement("div");
  row.className = "card" + (s.in_deck ? " have" : "");
  const label = document.createElement("span");
  const w = document.createElement("span");
  w.className = "w";
  w.textContent = s.word;
  const m = document.createElement("span");
  m.className = "m";
  m.textContent = `${s.reading} · ${s.meaning}`;
  label.append(w, m);
  const btn = document.createElement("button");
  btn.type = "button";
  if (s.in_deck) {
    btn.textContent = "✓ in deck";
    btn.disabled = true;
  } else {
    btn.textContent = "+";
    btn.title = "Add an Anki card";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        await callJson("/cards", {
          method: "POST",
          json: {
            page_id: sel.pageId,
            bubble_id: sel.bubbleId,
            deck: (await currentDeck()) || "",
            word: s.word,
            reading: s.reading,
            meaning: s.meaning,
            source_url: sel.pageUrl || "",
            source_title: sel.pageTitle || "",
          },
        });
        btn.textContent = "✓ added";
        row.classList.add("have");
      } catch (e) {
        if (e.error === "duplicate") {
          btn.textContent = "✓ in deck";
          row.classList.add("have");
        } else {
          btn.disabled = false;
          btn.textContent = "+";
          showMsg(entry, message(e.error));
        }
      }
    });
  }
  row.append(label, btn);
  return row;
}

async function explainSelection(sel) {
  if (!sel || sel.at <= lastShown) return;
  lastShown = sel.at;
  $("empty").hidden = true;
  const entry = $("entry-tpl").content.firstElementChild.cloneNode(true);
  $("entries").prepend(entry);
  while ($("entries").querySelectorAll(".entry").length > MAX_ENTRIES) $("entries").lastElementChild.remove();
  const jp = entry.querySelector(".jp");
  const tr = entry.querySelector(".tr");
  const notes = entry.querySelector(".notes");
  const cards = entry.querySelector(".cards");
  jp.textContent = "…";
  jp.classList.add("skeleton");
  entry.querySelector(".explain").hidden = true;

  // 1) furigana: local and instant
  try {
    const b = await callJson(`/pages/${sel.pageId}/bubbles/${sel.bubbleId}`);
    jp.innerHTML = b.ruby_html; // produced by the helper with all text HTML-escaped
    jp.classList.remove("skeleton");
  } catch (e) {
    jp.textContent = "";
    showMsg(entry, message(e.error));
    return;
  }

  // 2) explanation: one DeepSeek call, cached by the helper
  tr.textContent = "Explaining…";
  tr.classList.add("skeleton");
  try {
    const data = await callJson("/explain", {
      method: "POST",
      json: { page_id: sel.pageId, bubble_id: sel.bubbleId, deck: (await currentDeck()) || "" },
    });
    tr.classList.remove("skeleton");
    tr.textContent = `“${data.translation}”`;
    notes.replaceChildren(
      ...data.notes.map((n) => {
        const div = document.createElement("div");
        div.className = "note";
        const b = document.createElement("b");
        b.textContent = n.focus;
        div.append(b, ` — ${n.explanation}`);
        return div;
      }),
    );
    cards.replaceChildren(...data.suggestions.map((s) => cardRow(s, sel, entry)));
    entry.querySelector(".explain").hidden = false;
    if (data.anki === "unreachable") showMsg(entry, MESSAGES.anki_unreachable);
  } catch (e) {
    tr.textContent = "";
    tr.classList.remove("skeleton");
    showMsg(entry, message(e.error));
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "am:selected") explainSelection(msg.selection);
});

export { state, HelperError };

await connect();
await refreshSite();
{
  // A click that opened the panel arrives before this page listens: pick it up.
  const { lastSelection } = await chrome.storage.session.get("lastSelection");
  if (lastSelection && Date.now() - lastSelection.at < 15000) explainSelection(lastSelection);
}

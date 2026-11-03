// Clicked bubbles: furigana, explanation, dictionary entries and "+" cards. Everything from OCR, the LLM and the
// dictionary goes in with textContent; the only innerHTML is lib/text.js's rubyHtml, which escapes its input.
import { explain, FREE_URL } from "../lib/llm.js";
import { getSettings } from "../lib/settings.js";
import { openStore } from "../engine/store.js";
import { rubyHtml } from "../lib/text.js";
import { cardFields } from "../lib/cards.js";
import { explainErrorMessage, ankiErrorMessage, pictureFilename, freeRemainingAfterError, waitForBubbleText, cardDoneState, DICT_UNAVAILABLE, NO_DECK } from "./logic.js";
import { engine } from "./engine.js";
import { ankiForCards, knownWords } from "./anki.js";
import { currentDeck, openOwnKey } from "./settings.js";

const $ = (id) => document.getElementById(id);
const MAX_ENTRIES = 30;
let lastShown = 0;

// The explanation cache lives in the same IndexedDB as the engine's pages; without it explain() just skips caching.
let storeP = null;
const store = () => (storeP ||= openStore(indexedDB).catch(() => ({})));

// --- messages ---------------------------------------------------------------------------
function addMsg(el, text, action = null) {
  const box = el.querySelector(".msg");
  box.hidden = false;
  const line = document.createElement("div");
  line.textContent = text;
  box.append(line);
  if (action === "own_key") {
    const btn = el.querySelector(".own-key-btn");
    btn.hidden = false;
    btn.onclick = openOwnKey;
  }
}

// The concrete cause (HTTP status, network error, timeout) in small print under the message, for bug reports.
function addDetail(el, text) {
  const line = document.createElement("div");
  line.className = "msg-detail";
  line.textContent = `Details: ${text}`;
  el.querySelector(".msg").append(line);
}

function clearMsg(el) {
  const box = el.querySelector(".msg");
  box.hidden = true;
  box.replaceChildren();
}

// --- cards ------------------------------------------------------------------------------
function markDone(row, btn, outcome) {
  const { label, cls } = cardDoneState(outcome);
  row.classList.add(cls);
  btn.textContent = label;
  btn.disabled = true;
  btn.dataset.done = "1";
}

// Greys out a row whose word the deck already has (once the deck's known words have arrived).
function greyIfKnown(ctx, row, btn, card) {
  ctx.knownP.then((known) => {
    if (known && !btn.dataset.done && known.isKnown(card.word, card.reading)) markDone(row, btn, "in_deck");
  });
}

async function mine(ctx, card) {
  const deck = await currentDeck();
  if (!deck) throw Object.assign(new Error(NO_DECK), { shown: NO_DECK });
  const anki = await ankiForCards();
  const { pageId, bubbleId, pageUrl, pageTitle } = ctx.sel;
  const crop = await engine({ type: "eng:crop", pageId, bubbleId });
  if (!crop.ok) throw Object.assign(new Error(crop.error), { shown: explainErrorMessage(crop.error).text });
  const fields = cardFields({
    ...card,
    text: ctx.text,
    tokens: ctx.tokens,
    explanation: ctx.explanation,
    sourceUrl: pageUrl || "",
    sourceTitle: pageTitle || "",
  });
  await anki.addCard(deck, fields, crop.jpegBase64, pictureFilename(pageId, bubbleId));
  knownWords(deck).then((k) => k.add(card.word), () => {});
}

function addButton(ctx, row, card) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "+";
  btn.title = "Add an Anki card";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "…";
    clearMsg(ctx.el);
    try {
      await mine(ctx, card);
      markDone(row, btn, "added");
    } catch (e) {
      if (e.kind === "duplicate") return markDone(row, btn, "in_deck");
      btn.disabled = false;
      btn.textContent = "+";
      addMsg(ctx.el, e.shown || ankiErrorMessage(e.kind || "anki_error", e.kind ? e.message : ""));
    }
  });
  greyIfKnown(ctx, row, btn, card);
  return btn;
}

function suggestionRow(ctx, s) {
  const row = document.createElement("div");
  row.className = "card";
  const label = document.createElement("span");
  const w = document.createElement("span");
  w.className = "w";
  w.textContent = s.word;
  const m = document.createElement("span");
  m.className = "m";
  m.textContent = `${s.reading} · ${s.meaning}`;
  label.append(w, m);
  row.append(label, addButton(ctx, row, s));
  return row;
}

// --- dictionary ------------------------------------------------------------------------
function dictRow(ctx, entry, token, tags) {
  const row = document.createElement("div");
  row.className = "dict-entry";
  const reading = entry.kana[0] || "";
  const word = [token.lemma, token.surface].find((f) => entry.kanji.includes(f) || entry.kana.includes(f)) || entry.kanji[0] || reading;
  const body = document.createElement("div");
  const head = document.createElement("div");
  const w = document.createElement("span");
  w.className = "w";
  w.textContent = word;
  head.append(w);
  if (reading && reading !== word) {
    const r = document.createElement("span");
    r.className = "r";
    r.textContent = reading;
    head.append(r);
  }
  const pos = document.createElement("span");
  pos.className = "pos";
  pos.textContent = [...new Set(entry.senses.flatMap((s) => s.pos))].map((p) => tags[p] || p).join(", ");
  body.append(head, pos);
  entry.senses.forEach((s, i) => {
    const g = document.createElement("span");
    g.className = "g";
    g.textContent = `${entry.senses.length > 1 ? `${i + 1}. ` : ""}${s.glosses.join("; ")}`;
    body.append(g);
  });
  row.append(body, addButton(ctx, row, { word, reading, meaning: entry.senses[0].glosses.join("; ") }));
  return row;
}

async function lookup(ctx, token, idx, span) {
  const box = ctx.el.querySelector(".dict");
  const same = !box.hidden && box.dataset.token === String(idx);
  ctx.el.querySelectorAll(".tok.active").forEach((e) => e.classList.remove("active"));
  if (same) {
    box.hidden = true;
    return;
  }
  span.classList.add("active");
  box.hidden = false;
  box.dataset.token = String(idx);
  box.textContent = "Looking up…";
  const r = await engine({ type: "eng:lookup", surface: token.surface, lemma: token.lemma, reading: token.reading });
  if (box.dataset.token !== String(idx)) return; // another word was clicked meanwhile
  if (!r.ok) box.textContent = DICT_UNAVAILABLE;
  else if (!r.entries.length) box.textContent = `No dictionary entry for ${token.lemma || token.surface}.`;
  else box.replaceChildren(...r.entries.map((e) => dictRow(ctx, e, token, r.tags || {})));
}

// Punctuation is not looked up; every other token is a button-like span.
function renderSentence(ctx, jp) {
  jp.replaceChildren(
    ...ctx.tokens.map((t, i) => {
      if (t.pos === "記号") return document.createTextNode(t.surface);
      const span = document.createElement("span");
      span.className = "tok";
      span.innerHTML = rubyHtml(t.surface, [t]); // escaped by lib/text.js
      span.addEventListener("click", () => lookup(ctx, t, i, span));
      return span;
    }),
  );
}

// --- the entry for one clicked bubble --------------------------------------------------------
export async function explainSelection(sel) {
  if (!sel || sel.at <= lastShown) return;
  lastShown = sel.at;
  $("empty").hidden = true;
  const el = $("entry-tpl").content.firstElementChild.cloneNode(true);
  $("entries").prepend(el);
  while ($("entries").querySelectorAll(".entry").length > MAX_ENTRIES) $("entries").lastElementChild.remove();
  const jp = el.querySelector(".jp");
  const tr = el.querySelector(".tr");
  const ctx = { el, sel, text: "", tokens: [], explanation: null, knownP: Promise.resolve(null) };
  jp.textContent = "…";
  jp.classList.add("skeleton");
  el.querySelector(".explain").hidden = true;

  // 1) furigana: local and instant
  // A bubble clicked before it was read: wait here for its text instead of asking for a second click.
  const b = await waitForBubbleText(() => engine({ type: "eng:bubble", pageId: sel.pageId, bubbleId: sel.bubbleId }));
  jp.classList.remove("skeleton");
  if (!b.ok || !b.text) {
    jp.textContent = "";
    const { text, action } = explainErrorMessage(b.ok ? "no_text" : b.error);
    addMsg(el, text, action);
    return;
  }
  ctx.text = b.text;
  ctx.tokens = b.tokens;
  renderSentence(ctx, jp);

  // The deck's known words load in the background (Anki may ask permission, or not be running).
  ctx.knownP = currentDeck()
    .then((deck) => (deck ? knownWords(deck) : null))
    .catch((e) => {
      if (e.kind) addMsg(el, ankiErrorMessage(e.kind, e.message));
      return null;
    });

  // 2) explanation: local cache, then the free tier or the user's own provider
  tr.textContent = "Explaining…";
  tr.classList.add("skeleton");
  let cause = "";
  const onError = (d) => {
    cause = d;
    console.warn("[anki_manga] explanation failed:", d);
  };
  const r = await explain(ctx.text, { settings: await getSettings(), store: await store(), fetch: (...a) => fetch(...a), freeUrl: FREE_URL, onError });
  tr.classList.remove("skeleton");
  if (!r.ok) {
    tr.textContent = "";
    const { text, action } = explainErrorMessage(r.error);
    addMsg(el, text, action);
    if (cause) addDetail(el, cause);
    const left = freeRemainingAfterError(r.error);
    if (left !== null) chrome.storage.session.set({ freeRemaining: left });
    return;
  }
  if (r.remaining != null) chrome.storage.session.set({ freeRemaining: r.remaining });
  ctx.explanation = r.result;
  tr.textContent = `“${r.result.translation}”`;
  el.querySelector(".notes").replaceChildren(
    ...r.result.notes.map((n) => {
      const div = document.createElement("div");
      div.className = "note";
      const bold = document.createElement("b");
      bold.textContent = n.focus;
      div.append(bold, ` — ${n.explanation}`);
      return div;
    }),
  );
  el.querySelector(".cards").replaceChildren(...r.result.suggestions.map((s) => suggestionRow(ctx, s)));
  el.querySelector(".explain").hidden = false;
}

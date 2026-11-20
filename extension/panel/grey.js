// The state of the "+" buttons of an entry: added just now (green) or already in the deck (grey). Pure DOM state,
// no Anki calls: entries.js passes in how to load a deck's known words.
import { cardDoneState } from "./logic.js";

export function markDone(row, btn, outcome) {
  const { label, cls } = cardDoneState(outcome);
  row.classList.add(cls);
  btn.textContent = label;
  btn.disabled = true;
  btn.dataset.done = "1";
}

// Back to a plain "+" (the grey of a deck that is no longer the one cards go to).
function undoInDeck(row, btn) {
  row.classList.remove(cardDoneState("in_deck").cls);
  btn.textContent = "+";
  btn.disabled = false;
  delete btn.dataset.done;
}

// loadKnown(ctx) -> Promise<KnownWords | null>: the known words of the deck in force (null: none, or Anki unreachable).
// A ctx is {el: the entry's element, knownP: Promise of the above}; a card is {word, reading}.
// Tracks every "+" row that may still need greying: the deck can be chosen after the entries were rendered.
export function createGreyer(loadKnown) {
  const tracked = new Set();
  // Rows of entries that were dropped from the panel (MAX_ENTRIES) are forgotten.
  const dropGone = () => {
    for (const r of tracked) if (!r.ctx.el.isConnected) tracked.delete(r);
  };
  function apply(r) {
    const p = r.ctx.knownP;
    p.then((known) => {
      if (r.ctx.knownP !== p) return; // the deck changed meanwhile: the newer look decides, not this one
      if (known && !r.btn.dataset.done && known.isKnown(r.card.word, r.card.reading)) markDone(r.row, r.btn, "in_deck");
    });
  }
  return {
    // Greys out a row whose word the deck already has (once the deck's known words have arrived).
    track(ctx, row, btn, card) {
      const r = { ctx, row, btn, card };
      dropGone();
      tracked.add(r);
      apply(r);
    },
    // The deck changed (picked, confirmed, created): rows greyed for the old deck go back to "+", then every row is
    // checked against the new deck. Rows added just now stay green: that card is in the old deck, and it is a fact.
    refresh() {
      dropGone();
      for (const r of tracked) {
        if (r.row.classList.contains(cardDoneState("in_deck").cls)) undoInDeck(r.row, r.btn);
      }
      for (const ctx of new Set([...tracked].map((r) => r.ctx))) ctx.knownP = loadKnown(ctx);
      for (const r of tracked) apply(r);
    },
  };
}

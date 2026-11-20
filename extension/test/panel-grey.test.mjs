// The "already in the deck" greying of "+" rows (panel/grey.js): plain objects stand in for the DOM nodes.
import test from "node:test";
import assert from "node:assert/strict";
import { createGreyer, markDone } from "../panel/grey.js";

const el = () => ({ dataset: {}, disabled: false, textContent: "+", classes: new Set(), classList: null });
function node() {
  const n = el();
  n.classList = { add: (c) => n.classes.add(c), remove: (c) => n.classes.delete(c), contains: (c) => n.classes.has(c) };
  return n;
}
const makeRow = (ctx, word = "猫", reading = "ねこ") => ({ ctx, row: node(), btn: node(), card: { word, reading } });
const makeCtx = () => ({ el: { isConnected: true }, knownP: Promise.resolve(null) });
const knowing = (...words) => ({ isKnown: (w) => words.includes(w) });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a row whose word the deck has is greyed once the known words arrive; others stay '+'", async () => {
  const greyer = createGreyer(() => Promise.resolve(null));
  const ctx = makeCtx();
  ctx.knownP = Promise.resolve(knowing("猫"));
  const cat = makeRow(ctx);
  const dog = makeRow(ctx, "犬", "いぬ");
  for (const r of [cat, dog]) greyer.track(r.ctx, r.row, r.btn, r.card);
  await tick();
  assert.equal(cat.btn.textContent, "✓ in deck");
  assert.ok(cat.row.classes.has("have"));
  assert.equal(cat.btn.disabled, true);
  assert.equal(dog.btn.textContent, "+");
  assert.equal(dog.btn.disabled, false);
});

test("deck change: rows greyed for the old deck go back to '+' and are checked against the new deck", async () => {
  let current = knowing("猫", "犬");
  const greyer = createGreyer(() => Promise.resolve(current));
  const ctx = makeCtx();
  ctx.knownP = Promise.resolve(current);
  const cat = makeRow(ctx);
  const dog = makeRow(ctx, "犬", "いぬ");
  for (const r of [cat, dog]) greyer.track(r.ctx, r.row, r.btn, r.card);
  await tick();
  assert.equal(cat.btn.textContent, "✓ in deck");
  current = knowing("犬"); // the new deck has only the dog
  greyer.refresh();
  await tick();
  assert.equal(cat.btn.textContent, "+", "no longer greyed");
  assert.equal(cat.btn.disabled, false);
  assert.equal(cat.row.classes.has("have"), false);
  assert.equal(cat.btn.dataset.done, undefined);
  assert.equal(dog.btn.textContent, "✓ in deck");
  assert.equal(dog.row.classes.has("have"), true);
});

test("deck change to no deck (or unreachable Anki): every grey row is released", async () => {
  let current = knowing("猫");
  const greyer = createGreyer(() => Promise.resolve(current));
  const ctx = makeCtx();
  ctx.knownP = Promise.resolve(current);
  const cat = makeRow(ctx);
  greyer.track(cat.ctx, cat.row, cat.btn, cat.card);
  await tick();
  current = null;
  greyer.refresh();
  await tick();
  assert.equal(cat.btn.textContent, "+");
  assert.equal(cat.btn.disabled, false);
});

test("a card added just now stays green when the deck changes", async () => {
  const greyer = createGreyer(() => Promise.resolve(null));
  const ctx = makeCtx();
  const cat = makeRow(ctx);
  greyer.track(cat.ctx, cat.row, cat.btn, cat.card);
  markDone(cat.row, cat.btn, "added");
  greyer.refresh();
  await tick();
  assert.equal(cat.btn.textContent, "✓ added");
  assert.ok(cat.row.classes.has("added"));
  assert.equal(cat.btn.disabled, true);
});

test("a slow look at the old deck cannot grey a row after the deck changed", async () => {
  let release;
  const slowOld = new Promise((r) => (release = r));
  const greyer = createGreyer(() => Promise.resolve(knowing("犬")));
  const ctx = makeCtx();
  ctx.knownP = slowOld; // the old deck's words, still loading
  const cat = makeRow(ctx);
  greyer.track(cat.ctx, cat.row, cat.btn, cat.card);
  greyer.refresh(); // the deck changed before the old answer arrived
  release(knowing("猫")); // the old deck knew the cat
  await tick();
  assert.equal(cat.btn.textContent, "+");
  assert.equal(cat.row.classes.has("have"), false);
});

test("rows of entries that left the panel are forgotten", async () => {
  const loads = [];
  const greyer = createGreyer((ctx) => (loads.push(ctx), Promise.resolve(null)));
  const gone = makeCtx();
  const kept = makeCtx();
  const a = makeRow(gone);
  const b = makeRow(kept);
  greyer.track(a.ctx, a.row, a.btn, a.card);
  greyer.track(b.ctx, b.row, b.btn, b.card);
  gone.el.isConnected = false;
  greyer.refresh();
  assert.deepEqual(loads, [kept]);
});

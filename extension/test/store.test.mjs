import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openStore } from "../engine/store.js";

const bubbles = (n) => Array.from({ length: n }, (_, i) => ({ id: i, box: [0, 0, 1, 1], vertical: true, font_size: 1, lines: [] }));
const fresh = (opts) => openStore(new IDBFactory(), opts);

test("page roundtrip carries texts", async () => {
  const st = await fresh();
  await st.savePage("p", 100, 200, bubbles(2));
  await st.setText("p", 1, "あ");
  const page = await st.getPage("p");
  assert.deepEqual([page.width, page.height], [100, 200]);
  assert.deepEqual(page.bubbles.map((b) => b.text), [null, "あ"]);
  assert.equal(await st.getText("p", 1), "あ");
  assert.equal(await st.getText("p", 0), null);
  assert.equal(await st.getPage("missing"), null);
});

test("an empty text is a stored text, distinct from none", async () => {
  const st = await fresh();
  await st.savePage("p", 1, 1, bubbles(1));
  await st.setText("p", 0, "");
  assert.equal(await st.getText("p", 0), "");
  assert.equal((await st.getPage("p")).bubbles[0].text, "");
});

test("texts of one page do not leak into another", async () => {
  const st = await fresh();
  await st.savePage("a", 1, 1, bubbles(1));
  await st.savePage("b", 1, 1, bubbles(1));
  await st.setText("a", 0, "x");
  assert.equal((await st.getPage("b")).bubbles[0].text, null);
});

test("pageIdFor is the hex sha256 of the bytes", async () => {
  const st = await fresh();
  assert.equal(
    await st.pageIdFor(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(await st.pageIdFor(Uint8Array.of(1)), await st.pageIdFor(Uint8Array.of(1)));
  assert.notEqual(await st.pageIdFor(Uint8Array.of(1)), await st.pageIdFor(Uint8Array.of(2)));
});

test("images: only the newest maxImages are kept; re-saving refreshes", async () => {
  const st = await fresh({ maxImages: 3 });
  for (let i = 0; i < 5; i++) await st.saveImage(`p${i}`, Uint8Array.of(i));
  assert.equal(await st.loadImage("p0"), null);
  assert.equal(await st.loadImage("p1"), null);
  assert.deepEqual([...(await st.loadImage("p2"))], [2]);
  await st.saveImage("p2", Uint8Array.of(9)); // now the newest
  await st.saveImage("p5", Uint8Array.of(5));
  assert.equal(await st.loadImage("p3"), null);
  assert.deepEqual([...(await st.loadImage("p2"))], [9]);
  assert.deepEqual([...(await st.loadImage("p5"))], [5]);
  assert.equal(await st.countImages(), 3);
});

test("the default image retention is 300", async () => {
  const st = await fresh();
  for (let i = 0; i < 302; i++) await st.saveImage(`p${i}`, Uint8Array.of(1));
  assert.equal(await st.countImages(), 300);
  assert.equal(await st.loadImage("p1"), null);
  assert.notEqual(await st.loadImage("p2"), null);
});

test("pages and texts survive pruning of images", async () => {
  const st = await fresh({ maxImages: 1 });
  await st.savePage("a", 1, 1, bubbles(1));
  await st.setText("a", 0, "t");
  await st.saveImage("a", Uint8Array.of(1));
  await st.saveImage("b", Uint8Array.of(2));
  assert.equal(await st.loadImage("a"), null);
  assert.equal((await st.getPage("a")).bubbles[0].text, "t");
});

test("explanationKey normalizes (NFKC, trim) and is versioned", async () => {
  const st = await fresh();
  assert.equal(await st.explanationKey(" あ！ "), await st.explanationKey("あ!"));
  assert.match(await st.explanationKey("x"), /^[0-9a-f]{64}$/);
  const { createHash } = await import("node:crypto");
  assert.equal(await st.explanationKey("x"), createHash("sha256").update("1\nx").digest("hex"));
});

test("explanation roundtrip", async () => {
  const st = await fresh();
  await st.putExplanation("k", { translation: "x" });
  assert.deepEqual(await st.getExplanation("k"), { translation: "x" });
  assert.equal(await st.getExplanation("nope"), null);
});

test("clear drops pages, texts, images and explanations", async () => {
  const st = await fresh();
  await st.savePage("a", 1, 1, bubbles(1));
  await st.setText("a", 0, "t");
  await st.saveImage("a", Uint8Array.of(1));
  await st.putExplanation("k", {});
  await st.clear();
  assert.equal(await st.getPage("a"), null);
  assert.equal(await st.loadImage("a"), null);
  assert.equal(await st.getExplanation("k"), null);
});

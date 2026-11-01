import test from "node:test";
import assert from "node:assert/strict";
import { mergeDuplicates, readingOrder, bubbleToJson } from "../engine/boxes.js";

const b = (box, id = 0) => ({ id, box: box.map(Number), vertical: true, font_size: 20.0, lines: [] });

test("merge_duplicates keeps one", () => {
  const out = mergeDuplicates([b([256, 601, 289, 746]), b([259, 599, 292, 749], 1)]);
  assert.equal(out.length, 1);
});

test("merge keeps separate", () => {
  const out = mergeDuplicates([b([0, 0, 10, 10]), b([20, 0, 30, 10], 1)]);
  assert.equal(out.length, 2);
});

test("merge contained box", () => {
  const out = mergeDuplicates([b([0, 0, 100, 100]), b([10, 10, 50, 50], 1)]);
  assert.deepEqual(out.map((x) => x.box), [[0, 0, 100, 100]]);
});

test("reading order right to left then down", () => {
  const a = b([800, 100, 850, 300], 7);
  const bb = b([100, 120, 150, 320], 8);
  const c = b([900, 700, 950, 900], 9);
  const out = readingOrder([c, bb, a], 1000);
  assert.deepEqual(out.map((x) => x.box), [a.box, bb.box, c.box]);
  assert.deepEqual(out.map((x) => x.id), [0, 1, 2]);
});

test("to_json keys", () => {
  assert.deepEqual(Object.keys(bubbleToJson(b([0, 0, 1, 1]))).sort(), ["box", "font_size", "id", "lines", "vertical"]);
});

test("readingOrder does not mutate its input", () => {
  const a = b([800, 100, 850, 300], 7);
  readingOrder([a], 1000);
  assert.equal(a.id, 7);
});

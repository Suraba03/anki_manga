import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupOutput } from "../engine/textblocks.js";
import { yoloNms } from "../engine/detector.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
// Upright line quad (tl, tr, br, bl).
const quad = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const always = (v) => () => v;

test("two vertical lines far apart inside one block are split", () => {
  const blocks = [{ box: [280, 90, 540, 210], cls: 1 }];
  const lines = [quad(500, 100, 20, 100), quad(300, 100, 20, 100)];
  const out = groupOutput(blocks, lines, 1000, 1000, always(1));
  assert.equal(out.length, 2);
});

test("two close vertical lines stay in one block", () => {
  const blocks = [{ box: [450, 90, 540, 210], cls: 1 }];
  const lines = [quad(500, 100, 20, 100), quad(470, 100, 20, 100)];
  const out = groupOutput(blocks, lines, 1000, 1000, always(1));
  assert.equal(out.length, 1);
  assert.equal(out[0].lines.length, 2);
  assert.equal(out[0].vertical, true);
  assert.equal(out[0].fontSize, 20);
});

test("a line outside every block is dropped on low mask, kept as a scattered block on high mask", () => {
  const blocks = [{ box: [0, 0, 50, 50], cls: 1 }];
  const line = quad(600, 400, 20, 100);
  const seen = [];
  const low = groupOutput(blocks, [line], 1000, 1000, (...a) => (seen.push(a), a[0] === 0 ? 1 : 0.05));
  assert.ok(seen.some((a) => a.join() === "600,400,620,500"));
  assert.equal(low.filter((b) => b.lines.length === 1 && b.xyxy[0] === 600).length, 0);
  const high = groupOutput(blocks, [line], 1000, 1000, (x1) => (x1 === 0 ? 1 : 0.5));
  const scattered = high.find((b) => b.xyxy[0] === 600);
  assert.ok(scattered);
  assert.deepEqual(scattered.xyxy, [600, 400, 620, 500]);
  assert.equal(scattered.language, "unknown");
  assert.equal(scattered.vertical, true);
});

test("language is ja when cls is 1, eng when 0, unknown when 2", () => {
  for (const [cls, lang] of [[1, "ja"], [0, "eng"], [2, "unknown"]]) {
    const out = groupOutput([{ box: [90, 90, 230, 130], cls }], [quad(100, 100, 120, 20)], 500, 500, always(1));
    assert.equal(out[0].language, lang);
  }
});

test("blocks are sorted right to left for ja pages", () => {
  const blocks = [{ box: [100, 100, 140, 300], cls: 1 }, { box: [700, 100, 740, 300], cls: 1 }];
  const lines = [quad(105, 110, 25, 150), quad(705, 110, 25, 150)];
  const out = groupOutput(blocks, lines, 1000, 1000, always(1));
  assert.deepEqual(out.map((b) => b.xyxy[0]), [700, 100]); // block box is kept (adjust_bbox with_bbox=True)
});

// Expected values were produced by running comic_text_detector's group_output on the same inputs.
for (const c of fixture("textblocks-reference.json")) {
  test(`groupOutput matches the Python reference: ${c.name}`, () => {
    const mask = (x1, y1, x2, y2) => {
      let sum = 0, n = 0;
      for (const [rx1, ry1, rx2, ry2] of c.maskRects) {
        const w = Math.max(0, Math.min(x2, rx2) - Math.max(x1, rx1));
        const h = Math.max(0, Math.min(y2, ry2) - Math.max(y1, ry1));
        sum += w * h;
      }
      n = (x2 - x1) * (y2 - y1);
      return n > 0 ? Math.min(1, sum / n) : NaN;
    };
    const out = groupOutput(c.blocks, c.lines, c.imW, c.imH, mask);
    assert.deepEqual(out, c.expected);
  });
}

test("yoloNms keeps the higher score of two overlapping boxes (IoU 0.6)", () => {
  // rows: cx, cy, w, h, obj, cls0, cls1 ; box A 0..100 x 0..100, box B shifted so IoU = 0.6
  // inter = 100*75 -> shift 25 gives IoU 7500/12500 = 0.6.
  const rows = [
    [50, 50, 100, 100, 0.9, 0.9, 0.1],
    [75, 50, 100, 100, 0.95, 0.9, 0.1],
    [500, 500, 40, 40, 0.2, 0.9, 0.1], // below conf threshold
  ];
  const out = yoloNms(Float32Array.from(rows.flat()), 3, 7, {});
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].box, [25, 0, 125, 100]);
  assert.equal(out[0].cls, 0);
  assert.ok(Math.abs(out[0].score - 0.95 * 0.9) < 1e-6);
});

test("yoloNms does not suppress across classes", () => {
  const rows = [
    [50, 50, 100, 100, 0.9, 0.9, 0.1],
    [50, 50, 100, 100, 0.9, 0.1, 0.9],
  ];
  const out = yoloNms(Float32Array.from(rows.flat()), 2, 7, {});
  assert.deepEqual(out.map((d) => d.cls).sort(), [0, 1]);
});

test("yoloNms matches torch non_max_suppression on a random tensor", () => {
  const f = fixture("yolo-nms-reference.json");
  const out = yoloNms(Float32Array.from(f.rows), f.n, f.k, {});
  assert.equal(out.length, f.expected.length);
  out.forEach((d, i) => {
    const [x1, y1, x2, y2, score, cls] = f.expected[i];
    assert.equal(d.cls, cls);
    assert.ok(Math.abs(d.score - score) < 1e-6);
    d.box.forEach((v, j) => assert.ok(Math.abs(v - [x1, y1, x2, y2][j]) < 1e-3));
  });
});

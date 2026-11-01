import test from "node:test";
import assert from "node:assert/strict";
import { linesFromMap } from "../engine/dbnet.js";
import { minAreaRect } from "../engine/geometry.js";

function makeMap(w, h, rects, noise = 0.1) {
  const m = new Float32Array(w * h).fill(noise);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 0.9;
  }
  return m;
}

const bounds = (box) => ({
  minX: Math.min(...box.map((p) => p[0])), maxX: Math.max(...box.map((p) => p[0])),
  minY: Math.min(...box.map((p) => p[1])), maxY: Math.max(...box.map((p) => p[1])),
});

test("two filled rectangles give two unclipped boxes", () => {
  const rects = [[10, 10, 29, 19], [20, 40, 49, 49]];
  const lines = linesFromMap(makeMap(64, 64, rects), 64, 64);
  assert.equal(lines.length, 2);
  for (const [x0, y0, x1, y1] of rects) {
    // Min-area rect spans pixel centres: (x1-x0) x (y1-y0).
    const rw = x1 - x0, rh = y1 - y0;
    const d = (rw * rh * 1.5) / (2 * (rw + rh));
    const line = lines.find((l) => {
      const b = bounds(l.box);
      return b.minX < x1 && b.maxX > x0 && b.minY < y1 && b.maxY > y0;
    });
    assert.ok(line, `box for rect ${x0},${y0}`);
    assert.ok(line.score >= 0.85, `score ${line.score}`);
    assert.equal(line.box.length, 4);
    for (const p of line.box) assert.ok(Number.isInteger(p[0]) && Number.isInteger(p[1]));
    const b = bounds(line.box);
    assert.ok(Math.abs(b.minX - Math.max(0, x0 - d)) <= 1, `minX ${b.minX}`);
    assert.ok(Math.abs(b.maxX - (x1 + d)) <= 1, `maxX ${b.maxX}`);
    assert.ok(Math.abs(b.minY - (y0 - d)) <= 1, `minY ${b.minY}`);
    assert.ok(Math.abs(b.maxY - (y1 + d)) <= 1, `maxY ${b.maxY}`);
  }
});

test("a 1-px-wide blob is dropped", () => {
  const lines = linesFromMap(makeMap(64, 64, [[5, 5, 5, 30]]), 64, 64);
  assert.equal(lines.length, 0);
});

test("boxes scoring at or below boxThresh are dropped", () => {
  const m = makeMap(64, 64, [[10, 10, 29, 19]]);
  for (let x = 10; x <= 29; x++) for (let y = 10; y <= 19; y++) m[y * 64 + x] = 0.5;
  assert.equal(linesFromMap(m, 64, 64).length, 0);
  assert.equal(linesFromMap(m, 64, 64, { boxThresh: 0.4 }).length, 1);
});

test("boxes are clipped to the map", () => {
  const lines = linesFromMap(makeMap(64, 64, [[0, 0, 19, 9]]), 64, 64);
  assert.equal(lines.length, 1);
  for (const [x, y] of lines[0].box) assert.ok(x >= 0 && x <= 64 && y >= 0 && y <= 64);
});

test("a 1024x1024 map is processed quickly", () => {
  const rects = [];
  for (let i = 0; i < 20; i++) rects.push([20 + i * 40, 50, 40 + i * 40, 900]);
  const m = makeMap(1024, 1024, rects);
  const t = Date.now();
  const lines = linesFromMap(m, 1024, 1024);
  assert.equal(lines.length, 20);
  assert.ok(Date.now() - t < 2000);
});

test("an L-shaped blob yields one box scored over its own pixels", () => {
  const m = makeMap(64, 64, [[10, 10, 19, 49], [10, 40, 49, 49]]);
  const lines = linesFromMap(m, 64, 64);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].score >= 0.85, `score ${lines[0].score}`);
});

test("a rotated rectangle blob gives its rect grown by the unclip distance", () => {
  const w = 64, h = 64, rw = 40, rh = 12, deg = 20;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const m = new Float32Array(w * h).fill(0.1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - 32, dy = y - 32;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      if (Math.abs(u) <= rw / 2 && Math.abs(v) <= rh / 2) m[y * w + x] = 0.9;
    }
  }
  const lines = linesFromMap(m, w, h, { unclipRatio: 1.5 });
  assert.equal(lines.length, 1);
  const d = (rw * rh * 1.5) / (2 * (rw + rh));
  const [big, small] = [...minAreaRect(lines[0].box).size].sort((p, q) => q - p);
  assert.ok(Math.abs(big - (rw + 2 * d)) <= 1.5, `long ${big} vs ${rw + 2 * d}`);
  assert.ok(Math.abs(small - (rh + 2 * d)) <= 1.5, `short ${small} vs ${rh + 2 * d}`);
});

// Python parity: boxes from the real SegDetectorRepresenter (pyclipper round-join unclip) on synthetic maps.
// Fixture: tools/gen-dbnet-fixtures.py.
test("linesFromMap matches SegDetectorRepresenter.boxes_from_bitmap", async () => {
  const { readFileSync } = await import("node:fs");
  const ref = JSON.parse(readFileSync(new URL("./fixtures/dbnet-reference.json", import.meta.url), "utf8"));
  const sortKey = (b) => `${b[0][1]},${b[0][0]},${b[2][1]},${b[2][0]}`;
  for (const [i, c] of ref.cases.entries()) {
    const prob = Float32Array.from(c.prob, (ch) => Number(ch) / 10);
    const got = linesFromMap(prob, ref.size, ref.size).map((l) => l.box).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const want = [...c.boxes].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    assert.deepEqual(got, want, `case ${i}`);
  }
});

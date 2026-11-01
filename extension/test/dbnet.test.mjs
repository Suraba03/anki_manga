import test from "node:test";
import assert from "node:assert/strict";
import { linesFromMap } from "../engine/dbnet.js";

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

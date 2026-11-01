import test from "node:test";
import assert from "node:assert/strict";
import {
  convexHull, minAreaRect, boxPoints, orderBox, polygonArea, polygonPerimeter, quadsIntersect,
} from "../engine/geometry.js";

function rotatedRect(cx, cy, w, h, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

test("minAreaRect of a 40x10 rect rotated 30 degrees", () => {
  const r = minAreaRect(rotatedRect(50, 40, 40, 10, 30));
  const [lo, hi] = [...r.size].sort((a, b) => a - b);
  assert.ok(Math.abs(hi - 40) <= 0.5, `long side ${hi}`);
  assert.ok(Math.abs(lo - 10) <= 0.5, `short side ${lo}`);
  assert.ok(Math.abs(r.center[0] - 50) < 0.5 && Math.abs(r.center[1] - 40) < 0.5);
});

test("boxPoints reproduces the corners of the rect", () => {
  const corners = rotatedRect(50, 40, 40, 10, 30);
  const pts = boxPoints(minAreaRect(corners));
  assert.equal(pts.length, 4);
  for (const [x, y] of corners) {
    assert.ok(pts.some(([px, py]) => Math.hypot(px - x, py - y) < 0.01), `corner ${x},${y}`);
  }
});

test("convexHull of a square plus an interior point has 4 points", () => {
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
  assert.equal(hull.length, 4);
});

test("orderBox gives top-left, top-right, bottom-right, bottom-left", () => {
  const box = orderBox([[10, 10], [0, 10], [0, 0], [10, 0]]);
  assert.deepEqual(box, [[0, 0], [10, 0], [10, 10], [0, 10]]);
  const tilted = orderBox(boxPoints(minAreaRect(rotatedRect(50, 40, 40, 10, 30))));
  assert.ok(tilted[0][0] <= tilted[1][0] && tilted[3][0] <= tilted[2][0]);
  assert.ok(tilted[0][1] <= tilted[3][1] && tilted[1][1] <= tilted[2][1]);
});

test("polygonArea and polygonPerimeter", () => {
  const sq = [[0, 0], [4, 0], [4, 3], [0, 3]];
  assert.equal(polygonArea(sq), 12);
  assert.equal(polygonPerimeter(sq), 14);
});

test("quadsIntersect: overlapping, disjoint and touching", () => {
  const sq = (x, y, s = 10) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  assert.equal(quadsIntersect(sq(0, 0), sq(5, 5)), true);
  assert.equal(quadsIntersect(sq(0, 0), sq(30, 0)), false);
  assert.equal(quadsIntersect(sq(0, 0), sq(10, 0)), true);
  assert.equal(quadsIntersect(rotatedRect(0, 0, 40, 4, 45), rotatedRect(30, 0, 4, 4, 0)), false);
});

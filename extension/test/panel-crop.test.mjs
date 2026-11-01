import test from "node:test";
import assert from "node:assert/strict";
import { findPanelBox, scaledSize } from "../engine/panel-crop.js";

function blank(w, h, v = 255) {
  return { data: new Uint8ClampedArray(w * h * 4).fill(v), width: w, height: h };
}

function rect(img, x1, y1, x2, y2, thickness, v = 0) {
  const set = (x, y) => {
    const i = (y * img.width + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  };
  for (let t = 0; t < thickness; t++) {
    const o = t - Math.floor(thickness / 2);
    for (let x = x1 + o; x <= x2 - o; x++) { set(x, y1 + o); set(x, y2 - o); }
    for (let y = y1 + o; y <= y2 - o; y++) { set(x1 + o, y); set(x2 - o, y); }
  }
}

function pageWithPanels() {
  const img = blank(1000, 1400);
  rect(img, 20, 20, 980, 680, 4);
  rect(img, 20, 720, 980, 1380, 4);
  rect(img, 280, 200, 400, 300, 5); // noise inside the first panel
  return img;
}

const near = (box, want) => box.every((v, i) => Math.abs(v - want[i]) <= 10);

test("finds the enclosing panel", () => {
  const box = findPanelBox(pageWithPanels(), [700, 100, 760, 300]);
  assert.ok(near(box, [20, 20, 980, 680]), String(box));
});

test("finds the lower panel", () => {
  const box = findPanelBox(pageWithPanels(), [100, 900, 160, 1100]);
  assert.ok(near(box, [20, 720, 980, 1380]), String(box));
});

test("falls back to the bubble grown by 0.75x when there is no panel", () => {
  assert.deepEqual(findPanelBox(blank(1000, 1400), [500, 500, 540, 600]), [425, 425, 615, 675]);
});

test("the fallback is clamped to the page", () => {
  assert.deepEqual(findPanelBox(blank(1000, 1400), [0, 0, 40, 100]), [0, 0, 115, 175]);
});

test("scaledSize puts the long side at maxSide", () => {
  assert.deepEqual(scaledSize([20, 20, 980, 680], 600), { width: 600, height: 413 });
  assert.deepEqual(scaledSize([0, 0, 100, 400], 600), { width: 150, height: 600 });
  assert.deepEqual(scaledSize([0, 0, 1, 5000], 600), { width: 1, height: 600 });
});

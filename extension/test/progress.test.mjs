import test from "node:test";
import assert from "node:assert/strict";
import { createEta } from "../engine/progress.js";

const MB = 1e6;

test("no estimate until the download has run for a second", () => {
  let t = 0;
  const eta = createEta({ now: () => t });
  assert.equal(eta(0, 100 * MB), null);
  t = 500;
  assert.equal(eta(5 * MB, 100 * MB), null);
});

test("a steady 10 MB/s with 80 MB left -> about 8 s", () => {
  let t = 0;
  const eta = createEta({ now: () => t });
  let got = null;
  for (let s = 0; s <= 2; s += 0.5) {
    t = s * 1000;
    got = eta(s * 10 * MB, 100 * MB);
  }
  assert.ok(Math.abs(got - 8) < 0.5, `got ${got}`);
});

test("a short stall does not throw the estimate around", () => {
  let t = 0;
  const eta = createEta({ now: () => t });
  for (let s = 0; s <= 5; s += 0.5) {
    t = s * 1000;
    eta(s * 10 * MB, 200 * MB);
  }
  const before = eta(50 * MB, 200 * MB);
  t = 6000; // one second with no bytes
  const after = eta(50 * MB, 200 * MB);
  assert.ok(after < before * 2.5, `${before} -> ${after}`);
});

test("done -> 0", () => {
  let t = 0;
  const eta = createEta({ now: () => t });
  t = 2000;
  assert.equal(eta(100 * MB, 100 * MB), 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { OcrScheduler } from "../engine/scheduler.js";

const RGBA = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: i, box: [0, 0, 1, 1], text: null }));

// A fake runOcr that records bubble ids; the first call can be held until released.
function fakeOcr({ blockFirst = false, fail = new Set() } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let started;
  const firstStarted = new Promise((r) => (started = r));
  const runOcr = async (_rgba, bubble) => {
    calls.push(bubble.id);
    if (calls.length === 1) {
      started();
      if (blockFirst) await gate;
    }
    if (fail.has(bubble.id)) throw new Error("boom");
    return `t${bubble.id}`;
  };
  return { runOcr, calls, release, firstStarted };
}

test("processes bubbles in reading order and reports each text", async () => {
  const f = fakeOcr();
  const got = [];
  const s = new OcrScheduler(f.runOcr, (pid, bid, text) => got.push([pid, bid, text]));
  s.enqueuePage("p", RGBA, mk(3));
  await s.idle();
  assert.deepEqual(f.calls, [0, 1, 2]);
  assert.deepEqual(got, [["p", 0, "t0"], ["p", 1, "t1"], ["p", 2, "t2"]]);
  assert.equal(s.pending(), 0);
});

test("a prioritized bubble runs next", async () => {
  const f = fakeOcr({ blockFirst: true });
  const s = new OcrScheduler(f.runOcr, () => {});
  s.enqueuePage("p", RGBA, mk(5));
  await f.firstStarted;
  s.prioritize("p", 4);
  f.release();
  await s.idle();
  assert.deepEqual(f.calls.slice(0, 2), [0, 4]);
  assert.deepEqual([...f.calls].sort(), [0, 1, 2, 3, 4]);
});

test("later prioritize calls keep their order among urgent bubbles", async () => {
  const f = fakeOcr({ blockFirst: true });
  const s = new OcrScheduler(f.runOcr, () => {});
  s.enqueuePage("p", RGBA, mk(5));
  await f.firstStarted;
  s.prioritize("p", 3);
  s.prioritize("p", 2);
  f.release();
  await s.idle();
  assert.deepEqual(f.calls.slice(0, 3), [0, 3, 2]);
});

test("bubbles that already have text are not queued, and re-enqueueing is a no-op", async () => {
  const f = fakeOcr();
  const s = new OcrScheduler(f.runOcr, () => {});
  const bubbles = mk(3);
  bubbles[1].text = "known";
  s.enqueuePage("p", RGBA, bubbles);
  assert.equal(s.pending(), 2);
  s.enqueuePage("p", RGBA, bubbles); // queued ones are not duplicated
  assert.equal(s.pending(), 2);
  await s.idle();
  assert.deepEqual(f.calls, [0, 2]);
});

test("prioritize of an unknown or finished bubble is ignored", async () => {
  const f = fakeOcr();
  const s = new OcrScheduler(f.runOcr, () => {});
  s.prioritize("nope", 0);
  s.enqueuePage("p", RGBA, mk(1));
  await s.idle();
  s.prioritize("p", 0);
  await s.idle();
  assert.deepEqual(f.calls, [0]);
});

test("an OCR exception yields an empty text and the queue keeps going", async () => {
  const f = fakeOcr({ fail: new Set([1]) });
  const got = [];
  const s = new OcrScheduler(f.runOcr, (pid, bid, text) => got.push([bid, text]));
  s.enqueuePage("p", RGBA, mk(3));
  await s.idle();
  assert.deepEqual(got, [[0, "t0"], [1, ""], [2, "t2"]]);
});

test("a throwing onText does not stop the queue", async () => {
  const f = fakeOcr();
  const s = new OcrScheduler(f.runOcr, () => {
    throw new Error("sink down");
  });
  s.enqueuePage("p", RGBA, mk(2));
  await s.idle();
  assert.deepEqual(f.calls, [0, 1]);
});

test("pages are served in the order they were enqueued", async () => {
  const f = fakeOcr();
  const seen = [];
  const s = new OcrScheduler(f.runOcr, (pid, bid) => seen.push(`${pid}${bid}`));
  s.enqueuePage("a", RGBA, mk(2));
  s.enqueuePage("b", RGBA, mk(2));
  await s.idle();
  assert.deepEqual(seen, ["a0", "a1", "b0", "b1"]);
});

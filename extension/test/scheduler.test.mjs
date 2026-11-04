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

test("a failed OCR is reported as not to be stored, a successful one (even an empty text) as stored", async () => {
  const got = [];
  const runOcr = async (_r, b) => {
    if (b.id === 0) throw new Error("boom");
    return b.id === 1 ? "" : "t";
  };
  const s = new OcrScheduler(runOcr, (pid, bid, text, persist) => got.push([bid, text, persist]));
  s.enqueuePage("p", RGBA, mk(3));
  await s.idle();
  assert.deepEqual(got, [[0, "", false], [1, "", true], [2, "t", true]]);
});

test("clear drops queued jobs and discards the result of the running one", async () => {
  const f = fakeOcr({ blockFirst: true });
  const got = [];
  const s = new OcrScheduler(f.runOcr, (pid, bid, text) => got.push(bid));
  s.enqueuePage("p", RGBA, mk(4));
  await f.firstStarted;
  s.clear();
  assert.equal(s.pending(), 0);
  f.release();
  await s.idle();
  assert.deepEqual(got, [], "nothing is reported after a clear");
  assert.deepEqual(f.calls, [0], "queued jobs never ran");
  // The scheduler is usable again afterwards.
  s.enqueuePage("q", RGBA, mk(1));
  await s.idle();
  assert.deepEqual(got, [0]);
});

test("a failure of the running job after clear is discarded too", async () => {
  const f = fakeOcr({ blockFirst: true, fail: new Set([0]) });
  const got = [];
  const s = new OcrScheduler(f.runOcr, (pid, bid) => got.push(bid));
  s.enqueuePage("p", RGBA, mk(2));
  await f.firstStarted;
  s.clear();
  f.release();
  await s.idle();
  assert.deepEqual(got, []);
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

test("with a trace log, every job records queued, start, end and sunk with its page and bubble", async () => {
  const f = fakeOcr();
  const s = new OcrScheduler(f.runOcr, () => {});
  globalThis.__amTrace = [];
  try {
    s.enqueuePage("p", RGBA, mk(2));
    await s.idle();
    const log = globalThis.__amTrace;
    assert.deepEqual(
      log.map((m) => [m.name, m.pageId, m.bubbleId]),
      [
        ["bubble:queued", "p", 0], ["bubble:queued", "p", 1],
        ["bubble:start", "p", 0], ["bubble:end", "p", 0], ["bubble:sunk", "p", 0],
        ["bubble:start", "p", 1], ["bubble:end", "p", 1], ["bubble:sunk", "p", 1],
      ],
    );
  } finally {
    delete globalThis.__amTrace;
  }
});

test("without a trace log the scheduler leaves no global behind", async () => {
  const s = new OcrScheduler(fakeOcr().runOcr, () => {});
  s.enqueuePage("p", RGBA, mk(1));
  await s.idle();
  assert.equal(globalThis.__amTrace, undefined);
});

// --- priorities: pages by rank, hover first, late-bound place in the engine's queue ----------------------------------
import { Gate } from "../engine/rank-gate.js";

test("pages run by their rank (nearest first), not in arrival order; bubbles stay in reading order", async () => {
  const f = fakeOcr();
  const ranks = { far: 3, near: 1 };
  const s = new OcrScheduler(f.runOcr, () => {}, { pageRank: (id) => ranks[id] });
  const seen = [];
  s.runOcr = async (rgba, bubble) => { seen.push(bubble.id); return "t"; };
  s.enqueuePage("far", RGBA, mk(2));
  s.enqueuePage("near", RGBA, [{ id: 10, text: null }, { id: 11, text: null }]);
  await s.idle();
  assert.deepEqual(seen, [10, 11, 0, 1]);
});

test("a rank that changed between two bubbles is honoured at the next pick; far pages still run, last", async () => {
  const seen = [];
  const ranks = { a: 0, b: 1 };
  const s = new OcrScheduler(async (rgba, bubble) => { seen.push(bubble.id); if (bubble.id === 0) { ranks.a = 9; ranks.b = 0; } return "t"; }, () => {}, { pageRank: (id) => ranks[id] });
  s.enqueuePage("a", RGBA, [{ id: 0, text: null }, { id: 1, text: null }]);
  s.enqueuePage("b", RGBA, [{ id: 10, text: null }, { id: 11, text: null }]);
  await s.idle();
  assert.deepEqual(seen, [0, 10, 11, 1]); // the user scrolled to b after the first bubble of a; a's second bubble still ran
});

test("a hovered bubble beats every page rank", async () => {
  const f = fakeOcr({ blockFirst: true });
  const s = new OcrScheduler(f.runOcr, () => {}, { pageRank: (id) => (id === "near" ? 0 : 5) });
  s.enqueuePage("far", RGBA, mk(2));
  await f.firstStarted;
  s.enqueuePage("near", RGBA, mk(2));
  s.prioritize("far", 1);
  f.release();
  await s.idle();
  assert.deepEqual(f.calls.slice(0, 2), [0, 1]); // call 0 was far/0 (already running); then far/1 (hover), then near
});

test("a place in the engine's queue is late-bound: the bubble is chosen when the place comes, so a hover made while waiting wins", async () => {
  const gate = new Gate();
  const order = [];
  const ran = [];
  const release = [];
  // a detect job of the engine holds the queue
  gate.submit("detect", () => new Promise((r) => release.push(r)), { rank: () => 0 });
  const s = new OcrScheduler(async (rgba, bubble) => { ran.push(bubble.id); return "t"; }, () => {}, {
    slot: (rank, run) => gate.submit("ocr", run, { rank }),
  });
  await new Promise((r) => setTimeout(r, 5));
  s.enqueuePage("p", RGBA, mk(5));
  await new Promise((r) => setTimeout(r, 5)); // the scheduler has taken its place behind the detect
  s.prioritize("p", 4);
  release[0]();
  await s.idle();
  order.push(...ran);
  assert.deepEqual(order.slice(0, 2), [4, 0]);
});

test("a hovered bubble jumps the engine's queue: its place outranks queued detects", async () => {
  const gate = new Gate();
  const log = [];
  const releaseRunning = [];
  gate.submit("detect", () => new Promise((r) => releaseRunning.push(r)), { rank: () => 0 });
  await new Promise((r) => setTimeout(r, 5));
  gate.submit("detect", async () => { log.push("detect"); }, { rank: () => 0.5 });
  const s = new OcrScheduler(async (rgba, bubble) => { log.push(`ocr${bubble.id}`); return "t"; }, () => {}, {
    slot: (rank, run) => gate.submit("ocr", run, { rank }),
    pageRank: () => 1, // a neighbour page: behind the queued detect
  });
  s.enqueuePage("p", RGBA, mk(2));
  await new Promise((r) => setTimeout(r, 5));
  s.prioritize("p", 1); // hover
  releaseRunning[0]();
  await s.idle();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log.slice(0, 2), ["ocr1", "detect"]);
});

test("clear() while a place is pending leaves nothing behind", async () => {
  const gate = new Gate();
  const release = [];
  gate.submit("detect", () => new Promise((r) => release.push(r)));
  await new Promise((r) => setTimeout(r, 5));
  const ran = [];
  const s = new OcrScheduler(async (rgba, bubble) => { ran.push(bubble.id); return "t"; }, () => {}, { slot: (rank, run) => gate.submit("ocr", run, { rank }) });
  s.enqueuePage("p", RGBA, mk(3));
  s.clear();
  release[0]();
  await s.idle();
  assert.deepEqual(ran, []);
});

test("between two bubbles of the visible page, a queued detect of a farther page does not slip in", async () => {
  const gate = new Gate();
  const log = [];
  const release = [];
  gate.submit("detect", () => new Promise((r) => release.push(r)), { rank: () => 0 }); // the visible page's detect is running
  await new Promise((r) => setTimeout(r, 5));
  gate.submit("detect", async () => { log.push("detect of a neighbour"); }, { rank: () => 0.4 });
  const s = new OcrScheduler(async (rgba, bubble) => { log.push(`bubble${bubble.id}`); return "t"; }, () => {}, {
    slot: (rank, run) => gate.submit("ocr", run, { rank }),
    pageRank: () => 0,
  });
  s.enqueuePage("visible", RGBA, mk(3));
  release[0]();
  await s.idle();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ["bubble0", "bubble1", "bubble2", "detect of a neighbour"]);
});

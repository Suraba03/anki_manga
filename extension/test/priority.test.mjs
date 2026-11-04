import test from "node:test";
import assert from "node:assert/strict";
import { Priorities, readingQueues, FAR } from "../engine/priority.js";
import { Deferred } from "../engine/rank-gate.js";

// a pick after a finished job happens one timer tick later (see Gate.start)
const tick = () => new Promise((r) => setTimeout(r, 5));

test("a key without a priority is as good as visible and never far", () => {
  const p = new Priorities();
  assert.equal(p.rankOfKey("k"), 0);
  assert.equal(p.isFar("k"), false);
  assert.equal(p.rankOfKey(undefined), 0);
});

test("set/update keep the newest report per key (by n) and ignore malformed items", () => {
  const p = new Priorities();
  p.update([{ key: "a", d: 0.5, p: 0.5, n: 2 }, { key: "a", d: 3, p: 3, n: 1 }, { key: "b", d: "x", p: 1, n: 1 }, null, { d: 1, p: 1, n: 1 }]);
  assert.equal(p.rankOfKey("a"), 0.5);
  assert.equal(p.rankOfKey("b"), 0);
  p.update([{ key: "a", d: 1, p: 1.25, n: 3 }]);
  assert.equal(p.rankOfKey("a"), 1.25);
  p.update("garbage");
});

test("far means more than FAR viewports from the screen, by distance (not the direction-biased rank)", () => {
  const p = new Priorities();
  p.update([{ key: "near", d: 1.9, p: 2.5, n: 1 }, { key: "far", d: FAR + 0.1, p: FAR + 0.1, n: 1 }]);
  assert.equal(p.isFar("near"), false);
  assert.equal(p.isFar("far"), true);
});

test("a page id takes the priority of the request that made it; the hash of a key is ignored", () => {
  const p = new Priorities();
  p.update([{ key: "http://x/1.png", d: 0, p: 0, n: 1 }, { key: "http://x/2.png", d: 1, p: 1, n: 1 }]);
  p.bind("P1", "http://x/1.png#frag");
  p.bind("P2", "http://x/2.png");
  p.bind("P3", undefined); // a screenshot: no key
  assert.equal(p.rankOfPage("P1"), 0);
  assert.equal(p.rankOfPage("P2"), 1);
  assert.equal(p.rankOfPage("P3"), 0);
  assert.equal(p.rankOfPage("unknown"), 0);
  p.update([{ key: "http://x/2.png", d: 4, p: 4, n: 2 }]);
  assert.equal(p.rankOfPage("P2"), 4);
});

test("the maps stay bounded", () => {
  const p = new Priorities({ max: 10 });
  for (let i = 0; i < 100; i++) p.update([{ key: `k${i}`, d: 1, p: 1, n: 1 }]);
  assert.ok(p.byKey.size <= 10);
  assert.equal(p.rankOfKey("k99"), 1);
});

test("request(): registers the priority sent with it and hands out the rank and stale functions", () => {
  const q = readingQueues();
  const req = q.request({ key: "k#x", priority: { d: 0.2, p: 0.2, n: 5 } });
  assert.equal(req.rank(), 0.2);
  assert.equal(req.stale(), false);
  q.update([{ key: "k", d: 3, p: 3, n: 6 }]);
  assert.equal(req.rank(), 3);
  assert.equal(req.stale(), true);
  const none = q.request({});
  assert.equal(none.rank(), 0);
  assert.equal(none.stale(), false);
});

test("reads: at most 3 at a time, nearest first, and a read of a page that left the zone is deferred", async () => {
  const q = readingQueues();
  const started = [];
  const release = new Map();
  const read = (name) => {
    const req = q.request({ key: name, priority: { d: Number(name.slice(1)) / 10, p: Number(name.slice(1)) / 10, n: 1 } });
    return q.reads.submit("read", () => { started.push(name); return new Promise((r) => release.set(name, r)); }, req);
  };
  const results = ["p9", "p3", "p0", "p1", "p2"].map((n) => read(n).catch((e) => e));
  await tick();
  assert.deepEqual(started, ["p0", "p1", "p2"]); // p3 and p9 wait
  q.update([{ key: "p9", d: 5, p: 5, n: 2 }]);
  await tick();
  assert.ok((await results[0]) instanceof Deferred); // p9: far now, never read
  release.get("p0")();
  await tick();
  assert.deepEqual(started, ["p0", "p1", "p2", "p3"]);
});

test("compute: nearest page first; update() drops the queued detects of pages that left the zone, not the running one", async () => {
  const q = readingQueues();
  const started = [];
  const release = new Map();
  const detect = (key, d) => {
    const req = q.request({ key, priority: { d, p: d, n: 1 } });
    return q.compute.submit("detect", () => { started.push(key); return new Promise((r) => release.set(key, r)); }, req).then(() => key, (e) => e);
  };
  const results = [detect("a", 1.5), detect("b", 0.5), detect("c", 1)];
  await tick();
  assert.deepEqual(started, ["b"]); // the nearest runs first
  q.update([{ key: "b", d: 5, p: 5, n: 2 }, { key: "a", d: 5, p: 5, n: 2 }]); // the reader jumped away from both
  await tick();
  assert.ok((await results[0]) instanceof Deferred); // a: queued, now far
  release.get("b")(); // b was already running: it finishes
  assert.equal(await results[1], "b");
  await tick();
  assert.deepEqual(started, ["b", "c"]);
});

test("slot(): the OCR turn follows the page rank and is not droppable", async () => {
  const q = readingQueues();
  const order = [];
  const near = q.compute.submit("detect", async () => order.push("detect"), { rank: () => 1 });
  const turn = q.slot(() => 0, async () => order.push("ocr"));
  await Promise.all([near, turn]);
  assert.deepEqual(order, ["ocr", "detect"]);
});

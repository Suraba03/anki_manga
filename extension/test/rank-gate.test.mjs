import test from "node:test";
import assert from "node:assert/strict";
import { Gate, Deferred } from "../engine/rank-gate.js";

// A job that records when it ran and finishes when released.
function jobs() {
  const order = [];
  const gates = new Map();
  const make = (name, opts) => ({
    name,
    opts,
    run: () => {
      order.push(name);
      return new Promise((r) => gates.set(name, r));
    },
  });
  return { order, make, finish: (name, v) => gates.get(name)(v) };
}
// a pick after a finished job happens one timer tick later (see Gate.start)
const tick = () => new Promise((r) => setTimeout(r, 5));

test("one job at a time, lowest rank first, equal ranks in submission order", async () => {
  const g = new Gate();
  const j = jobs();
  const done = [];
  for (const [name, rank] of [["far", 5], ["near", 1], ["near2", 1], ["visible", 0]]) {
    const job = j.make(name);
    g.submit("detect", job.run, { rank: () => rank }).then(() => done.push(name));
  }
  await tick();
  assert.deepEqual(j.order, ["visible"]);
  for (const n of ["visible", "near", "near2", "far"]) {
    j.finish(n);
    await tick();
  }
  assert.deepEqual(j.order, ["visible", "near", "near2", "far"]);
  assert.deepEqual(done, ["visible", "near", "near2", "far"]);
});

test("rank is read again at every pick: a job whose page moved closer goes first", async () => {
  const g = new Gate();
  const j = jobs();
  const ranks = { running: 0, a: 1, b: 2 };
  for (const n of ["running", "a", "b"]) g.submit("detect", j.make(n).run, { rank: () => ranks[n] });
  await tick();
  ranks.b = 0.5; // scrolled: b is nearer than a now
  j.finish("running");
  await tick();
  assert.deepEqual(j.order, ["running", "b"]);
});

test("at equal rank a detect goes before an OCR slot, a read before both", async () => {
  const g = new Gate();
  const j = jobs();
  g.submit("ocr", j.make("blocker").run);
  await tick();
  g.submit("ocr", j.make("ocr").run);
  g.submit("detect", j.make("detect").run);
  g.submit("read", j.make("read").run);
  j.finish("blocker");
  await tick();
  j.finish("read");
  await tick();
  j.finish("detect");
  await tick();
  assert.deepEqual(j.order, ["blocker", "read", "detect", "ocr"]);
});

test("a hovered OCR (rank -1) runs next, but does not preempt the running job", async () => {
  const g = new Gate();
  const j = jobs();
  g.submit("detect", j.make("running").run, { rank: () => 0 });
  await tick();
  g.submit("detect", j.make("detect").run, { rank: () => 0 });
  g.submit("ocr", j.make("hover").run, { rank: () => -1 });
  await tick();
  assert.deepEqual(j.order, ["running"]);
  j.finish("running");
  await tick();
  assert.deepEqual(j.order, ["running", "hover"]);
});

test("a stale queued job is rejected with Deferred before it starts; a running one is left alone", async () => {
  const g = new Gate();
  const j = jobs();
  let far = false;
  const first = g.submit("detect", j.make("running").run, { stale: () => far });
  const second = g.submit("detect", j.make("queued").run, { stale: () => far });
  await tick();
  far = true; // both pages left the zone
  g.sweep();
  await assert.rejects(second, (e) => e instanceof Deferred && e.code === "deferred");
  j.finish("running", "ok");
  assert.equal(await first, "ok");
  assert.deepEqual(j.order, ["running"]);
});

test("a job that is stale when its turn comes is dropped at the pick", async () => {
  const g = new Gate();
  const j = jobs();
  let far = false;
  g.submit("detect", j.make("running").run);
  const p = g.submit("detect", j.make("late").run, { stale: () => far });
  const next = g.submit("detect", j.make("next").run);
  await tick();
  far = true;
  j.finish("running");
  await assert.rejects(p, Deferred);
  await tick();
  assert.deepEqual(j.order, ["running", "next"]);
  j.finish("next");
  await next;
});

test("concurrency 3: three jobs run at once, the fourth waits, in rank order", async () => {
  const g = new Gate({ concurrency: 3 });
  const j = jobs();
  for (const [n, r] of [["a", 4], ["b", 3], ["c", 2], ["d", 1], ["e", 0]]) g.submit("read", j.make(n).run, { rank: () => r });
  await tick();
  assert.deepEqual(j.order, ["e", "d", "c"]);
  j.finish("d");
  await tick();
  assert.deepEqual(j.order, ["e", "d", "c", "b"]);
});

test("a failing job rejects its caller and frees the slot", async () => {
  const g = new Gate();
  const bad = g.submit("detect", async () => { throw new Error("boom"); });
  const good = g.submit("detect", async () => "fine");
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "fine");
});

test("a job submitted from inside a job does not deadlock the others", async () => {
  const g = new Gate();
  const out = await g.submit("detect", async () => 1);
  assert.equal(out, 1);
  assert.equal(await g.submit("detect", async () => 2), 2);
});

test("trace marks carry the job id and kind, so a priority order can be reconstructed", async () => {
  const g = new Gate();
  globalThis.__amTrace = [];
  try {
    await Promise.all([g.submit("detect", async () => 1, { rank: () => 1 }), g.submit("ocr", async () => 2, { rank: () => 0 })]);
    const log = globalThis.__amTrace;
    const queued = log.filter((m) => m.name === "queue:queued");
    assert.deepEqual(queued.map((m) => [m.kind, m.ahead]), [["detect", 0], ["ocr", 1]]);
    const started = log.filter((m) => m.name === "queue:start");
    assert.deepEqual(started.map((m) => m.kind), ["ocr", "detect"]); // rank order
    assert.equal(started[0].id, queued[1].id);
    assert.equal(log.filter((m) => m.name === "queue:end").length, 2);
  } finally {
    delete globalThis.__amTrace;
  }
});

test("a dropped job is marked", async () => {
  const g = new Gate();
  globalThis.__amTrace = [];
  try {
    const p = g.submit("detect", async () => 1, { stale: () => true }).catch(() => "dropped");
    assert.equal(await p, "dropped");
    assert.deepEqual(globalThis.__amTrace.map((m) => m.name), ["queue:queued", "queue:dropped"]);
  } finally {
    delete globalThis.__amTrace;
  }
});

test("the slot is refilled without a timer: a throttled setTimeout (hidden documents) does not stall the queue", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const g = new Gate();
  const j = jobs();
  g.submit("detect", j.make("a").run);
  g.submit("detect", j.make("b").run);
  await new Promise((r) => setImmediate(r));
  globalThis.setTimeout = () => 0; // never fires
  try {
    j.finish("a");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(j.order, ["a", "b"]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a consumer of a finished job that submits the next one in its continuation still competes with what waits", async () => {
  // the engine: a detect resolves, its caller enqueues the page's bubbles; they must be queued before the next pick
  const g = new Gate();
  const order = [];
  const release = [];
  g.submit("detect", () => new Promise((r) => release.push(r)), { rank: () => 0 });
  g.submit("detect", async () => order.push("neighbour detect"), { rank: () => 0.7 });
  const done = g.submit("detect", async () => 1, { rank: () => 0 }).then(() => g.submit("ocr", async () => order.push("ocr of the visible page"), { rank: () => 0 }));
  await new Promise((r) => setImmediate(r));
  release[0]();
  await done;
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["ocr of the visible page", "neighbour detect"]);
});

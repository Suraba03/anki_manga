// tools/perf/analyze.mjs turns the raw trace logs of one jump into the numbers the reading-speed report shows.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeJump, pageNumber } from "../../tools/perf/analyze.mjs";

const key = (n) => `http://reader.test/p/${n}.png`;
const m = (t, name, data = {}) => ({ t, name, ...data });

// Page 100 is requested at 1082 while pages 98 and 99 are in flight; 99's detect runs first (FIFO).
function scenario() {
  const content = [
    m(1010, "observed", { key: key(100) }),
    m(1011, "fetch:start", { key: key(100) }),
    m(1061, "fetch:headers", { key: key(100), ok: true }),
    m(1081, "fetch:data", { key: key(100), len: 5000 }),
    m(1082, "send", { key: key(100), len: 5000 }),
    m(1020, "send", { key: key(98), len: 4800 }),
    m(2000, "reply", { key: key(98), ok: true }),
    m(1030, "send", { key: key(99), len: 4900 }),
    m(3000, "reply", { key: key(99), ok: true }),
    m(3830, "reply", { key: key(100), ok: true }),
    m(3840, "overlay", { key: key(100), pageId: "P100", bubbles: 2 }),
    m(3000, "badge", { key: key(98), phase: "ocr", done: 0, total: 0 }),
    m(3100, "badge", { key: key(99), phase: "ocr", done: 1, total: 1 }),
    m(3840, "badge", { key: key(100), phase: "ocr", done: 0, total: 2 }),
    m(4010, "text", { pageId: "P100", bubbleId: 0 }),
    m(4210, "text", { pageId: "P100", bubbleId: 1 }),
    m(4210, "badge", { key: key(100), phase: "ocr", done: 2, total: 2 }),
    m(3300, "report", { ready: 2, working: 1, failed: 0 }),
    m(4500, "report", { ready: 3, working: 0, failed: 0 }),
  ];
  const offscreen = [
    m(1040, "page:begin", { rid: 1, len: 4900 }),
    m(1210, "page:detect-call", { rid: 1 }),
    m(1210, "detect:queued", { ahead: 0 }),
    m(1210, "detect:start"),
    m(1100, "page:begin", { rid: 2, len: 5000 }),
    m(1180, "page:read", { rid: 2 }),
    m(1200, "page:hashed", { rid: 2, pageId: "P100" }),
    m(1210, "page:lookup", { rid: 2, cached: false }),
    m(1220, "page:detect-call", { rid: 2 }),
    m(1220, "detect:queued", { ahead: 1 }),
    m(2610, "detect:end"),
    m(2610, "detect:start"),
    m(3700, "detect:end"),
    m(3720, "page:detected", { rid: 2 }),
    m(3790, "page:image", { rid: 2 }),
    m(3800, "page:reply", { rid: 2 }),
    m(3795, "bubble:queued", { pageId: "P100", bubbleId: 0 }),
    m(3795, "bubble:queued", { pageId: "P100", bubbleId: 1 }),
    m(3795, "bubble:start", { pageId: "P100", bubbleId: 0 }),
    m(3795, "ocr:queued", { ahead: 0 }),
    m(3795, "ocr:start"),
    m(3990, "ocr:end"),
    m(3990, "bubble:end", { pageId: "P100", bubbleId: 0 }),
    m(3995, "bubble:sunk", { pageId: "P100", bubbleId: 0 }),
    m(3996, "bubble:start", { pageId: "P100", bubbleId: 1 }),
    m(3996, "ocr:queued", { ahead: 0 }),
    m(3996, "ocr:start"),
    m(4190, "ocr:end"),
    m(4190, "bubble:end", { pageId: "P100", bubbleId: 1 }),
    m(4195, "bubble:sunk", { pageId: "P100", bubbleId: 1 }),
  ].sort((a, b) => a.t - b.t || 0);
  return { content, offscreen };
}

test("pageNumber: the page index in the fixture URL", () => {
  assert.equal(pageNumber(key(100)), 100);
  assert.equal(pageNumber("http://x/other"), null);
});

test("analyzeJump: times are relative to the scroll", () => {
  const { content, offscreen } = scenario();
  const r = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen, panel: [], clickableAt: 3900 });
  assert.equal(r.bubbles, 2);
  assert.equal(r.overlayMs, 2840);
  assert.equal(r.firstTextMs, 3010);
  assert.equal(r.allTextsMs, 3210);
  assert.equal(r.clickableMs, 2900);
});

test("analyzeJump: pages in flight when the page was requested (content) and ahead of its detect (runtime)", () => {
  const { content, offscreen } = scenario();
  const r = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen, panel: [] });
  assert.equal(r.inFlightAtSend, 2); // 98 and 99 sent, not yet answered
  assert.equal(r.detectsAhead, 1);
  assert.deepEqual(r.detectAheadPages, [99]);
});

test("analyzeJump: where the time went", () => {
  const { content, offscreen } = scenario();
  const b = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen, panel: [] }).breakdown;
  assert.deepEqual(b, {
    scrollToObserved: 10,
    observedToFetch: 1,
    fetch: 50,
    toDataUrl: 20,
    workerHop: 18,
    read: 80,
    hash: 20,
    lookup: 10,
    detectQueueWait: 1390,
    detect: 1090,
    storePage: 20,
    storeImage: 70,
    replyHop: 30,
    layout: 10,
    ocrQueueWaitFirst: 0,
    ocrFirstBubble: 195,
    ocrRuntimeWaitFirst: 0,
    ocrMsPerBubble: [195, 194],
    ocrRunMsPerBubble: [195, 194],
  });
});

test("analyzeJump: a cached page has no detect part", () => {
  const { content, offscreen } = scenario();
  const cached = offscreen.filter((x) => !/detect/.test(x.name) && !/detected/.test(x.name));
  cached.find((x) => x.name === "page:lookup").cached = true;
  const b = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen: cached, panel: [] }).breakdown;
  assert.equal(b.detect, null);
  assert.equal(b.detectQueueWait, null);
  assert.equal(b.storePage, null);
});

test("analyzeJump: badge lag against the texts and against the panel summary", () => {
  const { content, offscreen } = scenario();
  const panel = [{ t: 3400, v: { ready: 2, working: 1, failed: 0 } }, { t: 4700, v: { ready: 3, working: 0, failed: 0 } }];
  const r = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen, panel });
  assert.equal(r.badge.doneMs, 3210); // the badge shows the check mark with the last text
  assert.equal(r.badge.afterAllTextsMs, 0);
  assert.equal(r.badge.reportMs, 290); // next report to the worker, 300 ms debounce
  assert.equal(r.badge.panelMs, 490); // the panel summary counts it
  assert.equal(r.badge.panelAfterAllTextsMs, 490);
});

test("analyzeJump: a missing overlay or panel update gives nulls, not NaN", () => {
  const r = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content: [m(1010, "observed", { key: key(100) })], offscreen: [], panel: [] });
  assert.equal(r.overlayMs, null);
  assert.equal(r.firstTextMs, null);
  assert.equal(r.allTextsMs, null);
  assert.equal(r.badge.panelMs, null);
});

test("analyzeJump: a fling starts at tScroll, but the numbers count from the arrival", () => {
  const { content, offscreen } = scenario();
  content.push(m(700, "observed", { key: key(100) })); // the page entered the zone while the fling was still going
  const r = analyzeJump({ page: 100, keyOf: key, tScroll: 500, tArrive: 1000, content: content.sort((a, b) => a.t - b.t), offscreen, panel: [] });
  assert.equal(r.overlayMs, 2840);
  assert.equal(r.allTextsMs, 3210);
  assert.equal(r.breakdown.scrollToObserved, -300);
});

test("analyzeJump: texts the overlay already had (a cached page) count at the overlay, and a replay does not count twice", () => {
  const { content, offscreen } = scenario();
  const c = content.filter((x) => x.name !== "text");
  c.find((x) => x.name === "overlay").known = [0];
  c.push(m(3900, "text", { pageId: "P100", bubbleId: 0 })); // the replay of a text it had
  c.push(m(4100, "text", { pageId: "P100", bubbleId: 1 }));
  const r = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content: c.sort((a, b) => a.t - b.t), offscreen, panel: [] });
  assert.equal(r.firstTextMs, 2840);
  assert.equal(r.allTextsMs, 3100);
});

test("analyzeJump: hovering a bubble -> time until its text is there (0 when it was known)", () => {
  const { content, offscreen } = scenario();
  const run = (hover) => analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen, panel: [], hover });
  assert.equal(run({ t: 3900, bubbleId: 1 }).hoverTextMs, 310); // text mark at 4210
  assert.equal(run({ t: 4500, bubbleId: 0 }).hoverTextMs, 0);
  assert.equal(run(undefined).hoverTextMs, null);
});

test("analyzeJump: an OCR job that waits in the runtime queue behind a detect is told apart from its run time", () => {
  const { content, offscreen } = scenario();
  const at = (t, name, data = {}) => ({ t, name, ...data });
  // bubble 0's OCR is queued at 3795 behind a detect of another page (3795..5000) and runs 5000..5200; bubble 1 never starts
  const log = offscreen
    .filter((x) => !/^(ocr:(queued|start|end)|bubble:(start|end|sunk))$/.test(x.name))
    .concat([
      at(3795, "page:detect-call", { rid: 3 }), at(3795, "detect:queued", { ahead: 0 }), at(3795, "detect:start"),
      at(3795, "bubble:start", { pageId: "P100", bubbleId: 0 }), at(3795, "ocr:queued", { ahead: 1 }),
      at(5000, "detect:end"), at(5000, "ocr:start"), at(5200, "ocr:end"), at(5200, "bubble:end", { pageId: "P100", bubbleId: 0 }),
    ])
    .sort((a, b) => a.t - b.t);
  const b = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen: log, panel: [] }).breakdown;
  assert.equal(b.ocrFirstBubble, 1405);
  assert.equal(b.ocrRuntimeWaitFirst, 1205);
  assert.deepEqual(b.ocrRunMsPerBubble, [200, null]);
});

test("analyzeJump: the content script's and the offscreen document's clocks differ by a few ms; a request is matched by length and nearest time", () => {
  const { content, offscreen } = scenario();
  const skewed = offscreen.map((x) => ({ ...x, t: x.t - (x.name === "page:begin" && x.rid === 2 ? 20 : 0) }));
  const b = analyzeJump({ page: 100, keyOf: key, tScroll: 1000, content, offscreen: skewed.sort((a, c) => a.t - c.t), panel: [] }).breakdown;
  assert.equal(b.workerHop, -2); // 1080 - 1082: the skew shows up here (and in replyHop) as a negative or inflated hop
  assert.equal(b.read, 100);
});

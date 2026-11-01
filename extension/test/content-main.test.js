// content/main.js in a sandbox: the browser and extension APIs are stubs, the page logic is the real file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PageFinder = require("../content/page-finder.js");
const source = fs.readFileSync(path.join(__dirname, "../content/main.js"), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects made inside the vm context have another prototype
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

function makeImg(src = "https://cdn.example/p1.jpg") {
  return {
    tagName: "IMG",
    src,
    dataset: {},
    getAttribute: () => null,
    complete: true,
    naturalWidth: 800,
    naturalHeight: 1200,
    isConnected: true,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 1200, right: 800, bottom: 1200 }),
  };
}

// replies: message type -> (msg) => reply. Returns the sandbox handles the tests need.
async function load({ imgs = [makeImg()], replies: given = {} } = {}) {
  const replies = { "am:page": () => ({ ok: true, page: page([null]) }), ...given };
  const sent = [];
  const timers = [];
  const observers = [];
  const listeners = [];
  const handles = [];
  const badges = new Map();
  class FakeObserver {
    constructor(cb, opts) {
      this.cb = cb;
      this.opts = opts;
      this.observed = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(el) {
      this.observed.add(el);
    }
    unobserve(el) {
      this.observed.delete(el);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const Overlay = {
    attach(img, page, opts) {
      const texts = new Map();
      const handle = {
        img,
        page,
        opts,
        texts,
        setText: (id, t) => texts.set(id, t),
        progress: () => ({ done: page.bubbles.filter((b) => texts.get(b.id) || b.text).length, total: page.bubbles.length }),
        destroy() {},
        update() {},
      };
      handles.push(handle);
      return handle;
    },
  };
  const Status = {
    attachBadge(el) {
      const b = { state: null, set(s) { b.state = s; }, update() {}, destroy() {} };
      badges.set(el, b);
      return b;
    },
    summary: () => ({}),
  };
  const sandbox = {
    AnkiManga: { PageFinder, Overlay, Status },
    URL,
    Promise,
    document: {
      baseURI: "https://reader.example/ch1",
      documentElement: { classList: { toggle() {} } },
      querySelectorAll: (sel) => (sel === "img" ? imgs : []),
      addEventListener() {},
    },
    window: { innerWidth: 1000, innerHeight: 2000, scrollX: 0, scrollY: 0, addEventListener() {} },
    location: { href: "https://reader.example/ch1" },
    IntersectionObserver: FakeObserver,
    MutationObserver: class { observe() {} },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    // No chrome.storage on purpose: a content script must not read the settings (they hold the API key).
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          sent.push(msg);
          const reply = replies[msg.type];
          return reply ? reply(msg) : { ok: true };
        },
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(source, vm.createContext(sandbox));
  await flush();
  const env = {
    sent,
    handles,
    badges,
    imgs,
    ofType: (type) => sent.filter((m) => m.type === type),
    // The observer that decides which pages to process (the second one made at start-up is the canvas one).
    pageObserver: () => [observers[0], ...observers.slice(2)].filter((o) => !o.disconnected).at(-1),
    intersect: async (img, entry) => {
      env.pageObserver().cb([{ target: img, isIntersecting: true, intersectionRatio: 1, intersectionRect: { height: 0 }, ...entry }]);
      await flush();
    },
    message: async (msg) => {
      for (const fn of listeners) fn(msg);
      await flush();
    },
    pendingTimers: (ms) => timers.filter((t) => t.ms === ms && !t.done),
    fire: async (ms) => {
      const t = timers.find((x) => x.ms === ms && !x.done);
      assert.ok(t, `a timer of ${ms} ms is pending`);
      t.done = true;
      t.fn();
      await flush();
    },
  };
  return env;
}

const page = (texts) => ({
  page_id: "P",
  width: 800,
  height: 1200,
  bubbles: texts.map((text, id) => ({ id, text, box: [0, 0, 1, 1] })),
});

test("content scripts get the performance mode from the worker and never touch chrome.storage", async () => {
  const env = await load({ replies: { "am:perf-mode": () => ({ ok: true, mode: "on-demand" }) } });
  assert.equal(env.ofType("am:perf-mode").length, 1);
  assert.ok(env.pageObserver().opts.threshold, "the on-demand observer is in use");
  await env.message({ type: "am:perf-mode", mode: "prefetch" });
  assert.equal(env.pageObserver().opts.threshold, undefined, "a pushed mode change switches the observer back");
});

test("on-demand mode starts a page only when at least half of it is visible", async () => {
  const env = await load({ replies: { "am:perf-mode": () => ({ ok: true, mode: "on-demand" }), "am:page": () => ({ ok: true, page: page([null]) }) } });
  const { threshold } = env.pageObserver().opts;
  assert.ok(Array.isArray(threshold) && threshold.includes(0.5), "the thresholds include 0.5");
  const [img] = env.imgs;
  await env.intersect(img, { intersectionRatio: 0.2 });
  assert.equal(env.ofType("am:page").length, 0, "a page that merely scrolls past is not started");
  await env.intersect(img, { intersectionRatio: 0.49 });
  assert.equal(env.ofType("am:page").length, 0);
  await env.intersect(img, { intersectionRatio: 0.5 });
  assert.equal(env.ofType("am:page").length, 1);
});

test("on-demand mode also starts a tall strip when it fills half of the viewport", async () => {
  const env = await load({ replies: { "am:perf-mode": () => ({ ok: true, mode: "on-demand" }) } });
  const [img] = env.imgs;
  await env.intersect(img, { intersectionRatio: 0.2, intersectionRect: { height: 900 } }); // viewport is 2000 high
  assert.equal(env.ofType("am:page").length, 0);
  await env.intersect(img, { intersectionRatio: 0.2, intersectionRect: { height: 1000 } });
  assert.equal(env.ofType("am:page").length, 1);
});

test("prefetch mode starts a page as soon as it is near the viewport", async () => {
  const env = await load();
  await env.intersect(env.imgs[0], { intersectionRatio: 0.01 });
  assert.equal(env.ofType("am:page").length, 1);
});

test("a cached page snapshot with unfinished bubbles is completed by replayed texts (badge not stuck)", async () => {
  const env = await load({ replies: { "am:page": () => ({ ok: true, page: page([null, null]) }) } });
  const [img] = env.imgs;
  await env.intersect(img, {});
  assert.deepEqual(plain(env.badges.get(img).state), { phase: "ocr", done: 0, total: 2 });
  assert.equal(env.ofType("am:watch").length, 1, "the page is watched");
  // what the worker's replay sends on am:watch
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 0, text: "あ" });
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 1, text: "い" });
  assert.deepEqual(plain(env.badges.get(img).state), { phase: "ocr", done: 2, total: 2 });

  // The same page re-attached later (one-page readers, virtual lists) reuses the cached, stale reply: still completed.
  const again = makeImg();
  env.imgs.push(again);
  await env.intersect(again, {});
  assert.equal(env.ofType("am:page").length, 1, "the cached reply is reused");
  assert.equal(env.ofType("am:watch").length, 2, "and watched again so the worker replays");
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 0, text: "あ" });
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 1, text: "い" });
  assert.deepEqual(plain(env.badges.get(again).state), { phase: "ocr", done: 2, total: 2 });
});

test("engine_error is retried after 5 s, 15 s and 60 s, then stops with the failed badge; no screenshot fallback", async () => {
  const env = await load({ replies: { "am:page": () => ({ ok: false, error: "engine_error" }) } });
  const [img] = env.imgs;
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1);
  assert.equal(env.pendingTimers(5000).length, 1);
  await env.fire(5000);
  assert.equal(env.ofType("am:page").length, 2);
  await env.fire(15000);
  assert.equal(env.ofType("am:page").length, 3);
  await env.fire(60000);
  assert.equal(env.ofType("am:page").length, 4);
  assert.equal([5000, 15000, 60000].flatMap((ms) => env.pendingTimers(ms)).length, 0, "no fifth attempt");
  assert.deepEqual(plain(env.badges.get(img).state), { phase: "error", error: "engine_error" });
  assert.equal(env.ofType("am:capture").length, 0, "an engine problem never asks for screenshots");
});

test("pages that failed with engine_error are processed again on am:retry (the engine became ready)", async () => {
  let ok = false;
  const env = await load({ replies: { "am:page": () => (ok ? { ok: true, page: page([null]) } : { ok: false, error: "engine_error" }) } });
  const [img] = env.imgs;
  await env.intersect(img, {});
  for (const ms of [5000, 15000, 60000]) await env.fire(ms);
  assert.equal(env.handles.length, 0);
  ok = true;
  await env.message({ type: "am:retry" });
  assert.equal(env.ofType("am:page").length, 5);
  assert.equal(env.handles.length, 1, "the page is drawn");
  assert.equal(env.ofType("am:capture").length, 0);
});

test("a later success clears the engine_error count: a new failure starts the backoff again", async () => {
  let ok = false;
  const env = await load({ replies: { "am:page": () => (ok ? { ok: true, page: page([null]) } : { ok: false, error: "engine_error" }) } });
  await env.intersect(env.imgs[0], {});
  ok = true;
  await env.fire(5000);
  assert.equal(env.handles.length, 1);
});

test("the screenshot fallback is for unreadable images only", async () => {
  for (const [error, captures] of [["fetch_failed", 1], ["bad_image", 1], ["engine_error", 0], ["extension_reloaded", 0], ["not_manga", 0]]) {
    const env = await load({ replies: { "am:page": () => ({ ok: false, error }), "am:capture": () => ({ ok: false, error: "capture_failed" }) } });
    await env.intersect(env.imgs[0], {});
    assert.equal(env.ofType("am:capture").length, captures, error);
  }
});

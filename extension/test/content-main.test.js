// content/main.js in a sandbox: the browser and extension APIs are stubs, the page logic is the real file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PageFinder = require("../content/page-finder.js");
const source = fs.readFileSync(path.join(__dirname, "../content/main.js"), "utf8");
// every am:page also carries how far its image is from the screen (here: on it), numbered from 1
const PRIO = { d: 0, p: 0, n: 1 };
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects made inside the vm context have another prototype
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

function makeImg(src = "https://cdn.example/p1.jpg", extra = {}) {
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
    ...extra,
  };
}

// A canvas element; `rect` can be changed by the test (scrolling).
function makeCanvas(rect = { left: 0, top: 0, width: 1000, height: 5000 }) {
  const c = { tagName: "CANVAS", width: 880, height: 1250, isConnected: true, rect, getBoundingClientRect: () => ({ ...c.rect, right: c.rect.left + c.rect.width, bottom: c.rect.top + c.rect.height }) };
  return c;
}

// replies: message type -> (msg) => reply. Returns the sandbox handles the tests need.
// fetch: url -> truthy (a response) or throws; canvas: "ok" | "tainted" (what a canvas copy of an <img> gives).
async function load({ imgs = [makeImg()], canvases = [], replies: given = {}, fetch: fetchImpl = () => { throw new TypeError("Failed to fetch"); }, canvas = "tainted", blobSize = 1000, trace = false, now = 0, syncThrow = null } = {}) {
  const replies = { "am:page": () => ({ ok: true, page: page([null]) }), ...given };
  const sent = [];
  const timers = [];
  const observers = [];
  const listeners = [];
  const handles = [];
  const badges = new Map();
  const fetched = [];
  const observeLog = []; // every IntersectionObserver.observe(el) call
  const mutationCallbacks = [];
  const drawn = [];
  const windowListeners = [];
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
      observeLog.push(el);
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
      const b = { state: null, destroyed: false, set(s) { b.state = s; }, update() {}, destroy() { b.destroyed = true; } };
      badges.set(el, b);
      return b;
    },
    summary: () => ({}),
  };
  const sandbox = {
    AnkiManga: { PageFinder, Overlay, Status },
    URL,
    Promise,
    performance, // only read while the harness trace is on
    Date: { now: () => now }, // the numbering of priority reports starts here
    ...(trace ? { __amTrace: [] } : {}),
    fetch: async (url) => {
      fetched.push(url);
      const resp = fetchImpl(url);
      if (resp === false) return { ok: false, status: 403 };
      return { ok: true, blob: async () => ({ tag: url, size: blobSize }) };
    },
    FileReader: class {
      readAsDataURL(blob) {
        Promise.resolve().then(() => {
          this.result = `data:image/png;fake,${blob.tag}`;
          this.onload();
        });
      }
    },
    document: {
      baseURI: "https://reader.example/ch1",
      documentElement: { classList: { toggle() {} } },
      querySelectorAll: (sel) => (sel === "img" ? imgs : sel === "canvas" ? canvases : []),
      addEventListener() {},
      createElement: () => ({
        getContext: () => ({ drawImage: (...a) => drawn.push(a) }),
        toBlob(cb) {
          if (canvas === "tainted") throw new Error("SecurityError");
          cb({ tag: "canvas" });
        },
      }),
    },
    window: { innerWidth: 1000, innerHeight: 2000, scrollX: 0, scrollY: 0, addEventListener: (type, fn) => windowListeners.push([type, fn]) },
    location: { href: "https://reader.example/ch1", origin: "https://reader.example" },
    IntersectionObserver: FakeObserver,
    MutationObserver: class { constructor(cb) { mutationCallbacks.push(cb); } observe() {} },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn, ms) => {
      // the fetch retry pause runs at once (a test would only wait for it); it stays in the log
      timers.push({ fn, ms, done: ms === 500 });
      if (ms === 500) Promise.resolve().then(fn);
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].done = true;
    },
    // No chrome.storage on purpose: a content script must not read the settings (they hold the API key).
    chrome: {
      runtime: {
        sendMessage: (msg) => {
          if (syncThrow && syncThrow(msg)) throw new Error("Extension context invalidated.");
          return (async () => {
            sent.push(msg);
            const reply = replies[msg.type];
            return reply ? reply(msg) : { ok: true };
          })();
        },
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(source, vm.createContext(sandbox));
  await flush();
  const env = {
    window: sandbox.window,
    log: sandbox.__amTrace,
    sent,
    handles,
    badges,
    imgs,
    fetched,
    timerDelays: () => timers.map((t) => t.ms),
    observeLog,
    mutate: async (records) => {
      for (const cb of mutationCallbacks) cb(records);
      await flush();
    },
    drawn,
    // the real (non-probe) screenshot requests
    captures: () => sent.filter((m) => m.type === "am:capture" && !m.probe),
    probes: () => sent.filter((m) => m.type === "am:capture" && m.probe),
    scroll: async () => {
      for (const [type, fn] of windowListeners) if (type === "scroll") fn({});
      await flush();
    },
    // the observer of canvas elements (the second one made at start-up)
    intersectCanvas: async (c) => {
      observers[1].cb([{ target: c, isIntersecting: true }]);
      await flush();
    },
    ofType: (type) => sent.filter((m) => m.type === type),
    // The observer that decides which pages to process (the second one made at start-up is the canvas one).
    pageObserver: () => [observers[0], ...observers.slice(2)].filter((o) => !o.disconnected).at(-1),
    intersect: async (img, entry) => {
      env.pageObserver().cb([{ target: img, isIntersecting: true, intersectionRatio: 1, intersectionRect: { height: 0 }, ...entry }]);
      await flush();
    },
    deliver: (msg) => {
      for (const fn of listeners) fn(msg); // synchronously, e.g. from inside a reply
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

// --- loading the image the way the page does ---------------------------------------------------
const SAME = "https://reader.example/p1.jpg";
const fake = (url) => `data:image/png;fake,${url}`;

test("a same-origin image is fetched by the content script and its bytes go to the worker", async () => {
  const env = await load({ imgs: [makeImg(SAME)], fetch: () => true });
  await env.intersect(env.imgs[0], {});
  assert.deepEqual(env.fetched, [SAME]);
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME, dataUrl: fake(SAME), priority: PRIO }]);
  assert.equal(env.handles.length, 1);
});

test("when the fetch fails, the image the page already shows is copied through a canvas", async () => {
  const env = await load({ imgs: [makeImg(SAME)], fetch: () => false, canvas: "ok" });
  await env.intersect(env.imgs[0], {});
  assert.equal(env.drawn.length, 1);
  assert.equal(env.drawn[0][0], env.imgs[0]);
  assert.equal(env.ofType("am:page")[0].dataUrl, fake("canvas"));
});

test("when fetch and canvas both fail, the worker is asked with the URL only", async () => {
  const env = await load({ imgs: [makeImg(SAME)], fetch: () => false, canvas: "tainted" });
  await env.intersect(env.imgs[0], {});
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME, priority: PRIO }]);
});

test("the canvas copy is only made of the image the <img> shows: a placeholder under data-src is not copied", async () => {
  const real = "https://cdn.example/real.jpg";
  const img = makeImg("https://reader.example/placeholder.png", { dataset: { src: real }, currentSrc: "https://reader.example/placeholder.png", naturalWidth: 600, naturalHeight: 860 });
  const env = await load({ imgs: [img], fetch: () => { throw new TypeError("network"); }, canvas: "ok" });
  await env.intersect(img, {});
  assert.equal(env.drawn.length, 0);
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: real, priority: PRIO }]);
});

test("the canvas copy is made when currentSrc is the URL (hash ignored)", async () => {
  const real = "https://cdn.example/real.jpg";
  const img = makeImg("https://reader.example/placeholder.png", { dataset: { src: real }, currentSrc: real + "#x" });
  const env = await load({ imgs: [img], fetch: () => { throw new TypeError("network"); }, canvas: "ok" });
  await env.intersect(img, {});
  assert.equal(env.drawn.length, 1);
  assert.equal(env.ofType("am:page")[0].dataUrl, fake("canvas"));
});

test("a reply for a page the reused <img> no longer shows is not drawn; the new page is processed", async () => {
  const [u12, u13] = ["https://cdn.example/12.jpg", "https://cdn.example/13.jpg"];
  const img = makeImg("https://reader.example/placeholder.png", { dataset: { src: u12 }, currentSrc: u12 });
  let release12;
  const slow12 = new Promise((r) => (release12 = r));
  const env = await load({
    imgs: [img],
    replies: { "am:page": (m) => (m.imageUrl === u12 ? slow12 : { ok: true, page: { ...page([null]), page_id: "P13" } }) },
  });
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1);
  // the reader reuses the <img> for page 13
  img.dataset.src = u13;
  img.currentSrc = u13;
  await env.mutate([{ type: "attributes", target: img }]);
  await env.intersect(img, {});
  assert.deepEqual(env.ofType("am:page").map((m) => m.imageUrl), [u12, u13]);
  release12({ ok: true, page: { ...page([null]), page_id: "P12" } });
  await flush();
  assert.deepEqual(env.handles.map((h) => h.page.page_id), ["P13"], "page 12 is not drawn on the image that shows 13");
});

test("an image that is not displayed yet is not copied through a canvas", async () => {
  const lazy = makeImg("data:image/gif;base64,R0lGOD", { dataset: { src: SAME }, complete: false, naturalWidth: 0, naturalHeight: 0 });
  const env = await load({ imgs: [lazy], fetch: () => false, canvas: "ok" });
  await env.intersect(lazy, {});
  assert.equal(env.drawn.length, 0);
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME, priority: PRIO }]);
});

test("a blob: image is never sent to the worker as a URL; when its bytes can't be read, it is screenshotted", async () => {
  const blob = "blob:https://reader.example/1-2-3";
  const ok = await load({ imgs: [makeImg(blob)], fetch: () => true });
  await ok.intersect(ok.imgs[0], {});
  assert.equal(ok.ofType("am:page")[0].dataUrl, fake(blob));

  const bad = await load({ imgs: [makeImg(blob)], fetch: () => false, canvas: "tainted", replies: { "am:capture": (m) => (m.probe ? { ok: true } : { ok: false, error: "fetch_failed" }) } });
  await bad.intersect(bad.imgs[0], {});
  assert.equal(bad.ofType("am:page").length, 0, "no am:page with a blob: URL");
  assert.equal(bad.captures().length, 1, "falls back to a screenshot");
});

const dead = () => { throw new TypeError("CORS"); };

test("a CDN image is fetched too; a thrown fetch is retried once, and after two failed images the host is not fetched again", async () => {
  const urls = ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg", "https://cdn.example/3.jpg"];
  const imgs = urls.map((u) => makeImg(u));
  const other = makeImg("https://other.example/4.jpg");
  const env = await load({ imgs: [...imgs, other], fetch: (url) => (url.includes("cdn.example") ? dead() : true) });
  for (const img of [...imgs, other]) await env.intersect(img, {});
  assert.deepEqual(env.fetched, [urls[0], urls[0], urls[1], urls[1], "https://other.example/4.jpg"], "the third image of the host skips the fetch");
  assert.deepEqual(env.ofType("am:page").map((m) => !!m.dataUrl), [false, false, false, true]);
});

test("a fetch that throws is retried once after 500 ms; when the retry works the bytes are sent and no URL request follows", async () => {
  const seen = new Set();
  const env = await load({ imgs: [makeImg("https://cdn.example/1.jpg")], fetch: (url) => (seen.has(url) ? true : (seen.add(url), dead())) });
  await env.intersect(env.imgs[0], {});
  assert.equal(env.fetched.length, 2);
  assert.ok(env.timerDelays().includes(500));
  assert.deepEqual(env.ofType("am:page").map((m) => !!m.dataUrl), [true]);
});

test("a fetch that throws twice falls back as before (canvas, then the URL)", async () => {
  const env = await load({ imgs: [makeImg(SAME)], fetch: dead, canvas: "ok" });
  await env.intersect(env.imgs[0], {});
  assert.equal(env.fetched.length, 2);
  assert.equal(env.ofType("am:page")[0].dataUrl, fake("canvas"));
  const bare = await load({ imgs: [makeImg(SAME)], fetch: dead });
  await bare.intersect(bare.imgs[0], {});
  assert.deepEqual(plain(bare.ofType("am:page")), [{ type: "am:page", imageUrl: SAME, priority: PRIO }]);
});

test("a failure is a fetch that threw on both tries; a success in between resets the count", async () => {
  const seen = new Set();
  const flaky = (url) => (seen.has(url) ? true : (seen.add(url), dead()));
  const kinds = { 1: dead, 2: () => true, 3: dead, 4: flaky, 5: dead, 6: () => true };
  const imgs = [1, 2, 3, 4, 5, 6].map((n) => makeImg(`https://cdn.example/${n}.jpg`));
  const env = await load({ imgs, fetch: (url) => kinds[url.match(/(\d)\.jpg/)[1]](url) });
  for (const img of imgs) await env.intersect(img, {});
  // dead (2 calls), ok, dead (2), flaky (2), dead (2), ok: never two failed images in a row
  assert.equal(env.fetched.length, 10);
  for (const n of [7, 8, 9]) {
    kinds[n] = dead;
    const img = makeImg(`https://cdn.example/${n}.jpg`);
    env.imgs.push(img);
    await env.intersect(img, {});
  }
  assert.equal(env.fetched.length, 14, "7 and 8 fail twice in a row: the host is blocked and 9 is not fetched");
});

test("an HTTP error from a CDN host does not stop the content script from fetching its next image", async () => {
  const a = makeImg("https://cdn.example/1.jpg");
  const b = makeImg("https://cdn.example/2.jpg");
  const env = await load({ imgs: [a, b], fetch: (url) => url.endsWith("1.jpg") ? false : true });
  await env.intersect(a, {});
  await env.intersect(b, {});
  assert.deepEqual(env.fetched, ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"]);
  assert.equal(env.ofType("am:page")[1].dataUrl, fake("https://cdn.example/2.jpg"));
});

test("an image whose data URL would be over 48 MB is left to the worker's own fetch", async () => {
  const env = await load({ imgs: [makeImg(SAME)], fetch: () => true, blobSize: 40 * 1024 * 1024 }); // 53 MB as base64
  await env.intersect(env.imgs[0], {});
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME, priority: PRIO }]);
  const small = await load({ imgs: [makeImg(SAME)], fetch: () => true, blobSize: 30 * 1024 * 1024 }); // 40 MB
  await small.intersect(small.imgs[0], {});
  assert.ok(small.ofType("am:page")[0].dataUrl);
});

// --- badges and host requests only for manga-sized images -----------------------------------------
const placeholder = (extra = {}) => {
  const listeners = [];
  const img = makeImg("data:image/gif;base64,R0lGOD", {
    dataset: { src: "https://cdn.example/lazy.jpg" },
    complete: false,
    naturalWidth: 0,
    naturalHeight: 0,
    addEventListener: (type, fn) => listeners.push(fn),
    removeEventListener() {},
    ...extra,
  });
  // the browser finished loading the real image
  img.loaded = async (w, h) => {
    Object.assign(img, { src: "https://cdn.example/lazy.jpg", currentSrc: "https://cdn.example/lazy.jpg", complete: true, naturalWidth: w, naturalHeight: h });
    for (const fn of [...listeners]) fn();
    await flush();
  };
  return img;
};
const noPermission = { "am:page": () => ({ ok: false, error: "no_image_permission", host: "cdn.example" }) };

test("an image that is not displayed yet gets no 'finding bubbles' badge", async () => {
  const img = placeholder();
  const env = await load({ imgs: [img], replies: noPermission });
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1, "it is still processed (prefetch)");
  assert.equal(env.badges.get(img), undefined);
});

test("no_image_permission for a small image: no badge, no host request", async () => {
  const img = placeholder();
  const env = await load({ imgs: [img], replies: noPermission });
  await env.intersect(img, {});
  await img.loaded(300, 250);
  assert.equal(env.badges.get(img)?.state ?? null, null);
  assert.equal(env.ofType("am:missing-host").length, 0);
  assert.equal(env.captures().length + env.probes().length, 0);
});

test("no_image_permission for a manga-sized image: badge and host request", async () => {
  const img = placeholder();
  const env = await load({ imgs: [img], replies: noPermission });
  await env.intersect(img, {});
  assert.equal(env.ofType("am:missing-host").length, 0, "not before the size is known");
  await img.loaded(800, 1200);
  assert.deepEqual(plain(env.badges.get(img).state), { phase: "error", error: "no_image_permission" });
  assert.deepEqual(plain(env.ofType("am:missing-host")), [{ type: "am:missing-host", host: "cdn.example" }]);
});

test("a displayed manga-sized image with no_image_permission reports the host at once", async () => {
  const env = await load({ replies: noPermission });
  await env.intersect(env.imgs[0], {});
  assert.deepEqual(plain(env.badges.get(env.imgs[0]).state), { phase: "error", error: "no_image_permission" });
  assert.equal(env.ofType("am:missing-host").length, 1);
});

test("an unreadable small image is never screenshotted", async () => {
  const img = placeholder();
  const env = await load({ imgs: [img], replies: { "am:page": () => ({ ok: false, error: "fetch_failed" }) } });
  await env.intersect(img, {});
  await img.loaded(120, 120);
  assert.equal(env.probes().length + env.captures().length, 0);
  assert.equal(env.badges.get(img)?.state ?? null, null);
});

// --- screenshots: permission asked at once, tall pages in slices --------------------------------------
const unreadable = { "am:page": () => ({ ok: false, error: "fetch_failed" }) };
const outOfView = () => ({ left: 0, top: 5000, width: 800, height: 1200, right: 800, bottom: 6200 });

test("the screenshot permission is probed once; when missing, every queued element gets the badge, even out of view", async () => {
  const a = makeImg(SAME + "?a", { getBoundingClientRect: outOfView });
  const b = makeImg(SAME + "?b", { getBoundingClientRect: outOfView });
  const env = await load({ imgs: [a, b], replies: { ...unreadable, "am:capture": () => ({ ok: false, error: "capture_failed" }) } });
  await env.intersect(a, {});
  assert.equal(env.probes().length, 1);
  assert.deepEqual(plain(env.badges.get(a).state), { phase: "error", error: "capture_failed" });
  await env.intersect(b, {});
  assert.equal(env.probes().length, 1, "not asked again");
  assert.deepEqual(plain(env.badges.get(b).state), { phase: "error", error: "capture_failed" });
  assert.equal(env.captures().length, 0);
  await env.message({ type: "am:retry" });
  assert.equal(env.probes().length, 2, "asked again after am:retry");
});

test("with the permission, an element in view is captured whole after the probe", async () => {
  const env = await load({ replies: { ...unreadable, "am:capture": (m) => (m.probe ? { ok: true } : { ok: true, page: { ...page([null]), page_id: "C" } }) } });
  await env.intersect(env.imgs[0], {});
  assert.equal(env.probes().length, 1);
  assert.deepEqual(plain(env.captures().map((m) => m.rect)), [{ x: 0, y: 0, width: 800, height: 1200 }]);
  assert.equal(env.handles[0].img, env.imgs[0]);
});

test("a short element that is only partly visible waits for the whole page", async () => {
  const img = makeImg(SAME, { getBoundingClientRect: () => ({ left: 0, top: 1500, width: 800, height: 1000, right: 800, bottom: 2500 }) });
  const env = await load({ imgs: [img], replies: unreadable });
  await env.intersect(img, {});
  await env.scroll();
  assert.equal(env.captures().length, 0);
});

const sliceReply = (n) => (m) => (m.probe ? { ok: true } : { ok: true, page: { ...page([null]), page_id: `S${n.count++}` } });

test("a tall canvas is captured in slices: the visible part after scrolling stops, never what was captured", async () => {
  const canvas = makeCanvas(); // 1000 x 5000 in a 1000 x 2000 viewport
  const n = { count: 1 };
  const env = await load({ canvases: [canvas], replies: { "am:capture": sliceReply(n) } });
  await env.intersectCanvas(canvas);
  assert.equal(env.captures().length, 1);
  assert.deepEqual(plain(env.captures()[0].rect), { x: 0, y: 0, width: 1000, height: 2000 });

  // The overlay hangs on a stand-in whose rect follows the canvas.
  const target = env.handles[0].img;
  assert.notEqual(target, canvas);
  assert.equal(target.isConnected, true);
  assert.deepEqual(plain(target.getBoundingClientRect()).height, 2000);
  canvas.rect.top = -500;
  assert.equal(target.getBoundingClientRect().top, -500);
  assert.equal(target.getBoundingClientRect().height, 2000);
  assert.ok(env.badges.get(target), "the slice has its own badge");
  canvas.isConnected = false;
  assert.equal(target.isConnected, false);
  canvas.isConnected = true;

  // Scrolled to -1500: rows 1500..3500 are visible, 0..2000 are done, so 2000..3500 remain.
  canvas.rect.top = -1500;
  await env.scroll();
  assert.equal(env.captures().length, 1, "nothing while the page is scrolling");
  await env.fire(400);
  assert.equal(env.captures().length, 2);
  const slice = plain(env.captures()[1].rect);
  assert.deepEqual([slice.x, Math.round(slice.y), slice.width, Math.round(slice.height)], [0, 500, 1000, 1500]);
  assert.equal(env.handles.length, 2);
  assert.equal(env.handles[1].page.page_id, "S2");
  assert.equal(Math.round(env.handles[1].img.getBoundingClientRect().top), 500);

  // Same view again: everything visible is covered.
  await env.scroll();
  await env.fire(400);
  assert.equal(env.captures().length, 2);
});

// A reply that first tells the content script the screenshot was taken (am:capture-taken), then moves the page.
const withAck = (env, canvas, { before = 0, after = 0, ack = true, n = { count: 1 } } = {}) => (m) => {
  if (m.probe) return { ok: true };
  canvas.rect.top += before;
  if (ack) env.deliver({ type: "am:capture-taken", id: m.id });
  canvas.rect.top += after;
  return { ok: true, page: { ...page([null]), page_id: `S${n.count++}` } };
};
const loadTall = async (opts) => {
  const canvas = makeCanvas();
  const holder = {};
  const env = await load({ canvases: [canvas], replies: { "am:capture": (m) => holder.reply(m) } });
  holder.reply = withAck(env, canvas, opts);
  return { canvas, env };
};

test("a slice is not drawn when the page moved before the screenshot was taken; it is taken again when scrolling stops", async () => {
  const canvas = makeCanvas();
  const holder = {};
  const env = await load({ canvases: [canvas], replies: { "am:capture": (m) => holder.reply(m) } });
  let first = true;
  holder.reply = (m) => withAck(env, canvas, { before: !m.probe && first ? ((first = false), -100) : 0 })(m);
  await env.intersectCanvas(canvas);
  assert.equal(env.captures().length, 1);
  assert.equal(env.handles.length, 0, "the stale reply is dropped");
  assert.ok([...env.badges.values()].every((b) => b.destroyed), "and its badge too");
  await env.fire(400); // no scroll event needed: a retry is scheduled
  assert.equal(env.captures().length, 2);
  assert.equal(env.handles.length, 1);
});

test("a slice is kept when the page moves after the screenshot was taken (the overlay follows the page)", async () => {
  const { canvas, env } = await loadTall({ after: -300 });
  await env.intersectCanvas(canvas);
  assert.equal(env.handles.length, 1);
  assert.equal(env.handles[0].img.getBoundingClientRect().top, -300);
});

test("without the 'screenshot taken' message the move check is skipped", async () => {
  const { canvas, env } = await loadTall({ before: -100, ack: false });
  await env.intersectCanvas(canvas);
  assert.equal(env.handles.length, 1);
});

test("the capture requests of different slices carry different ids", async () => {
  const { canvas, env } = await loadTall();
  await env.intersectCanvas(canvas);
  canvas.rect.top = -1500;
  await env.scroll();
  await env.fire(400);
  const ids = env.captures().map((m) => m.id);
  assert.equal(ids.length, 2);
  assert.ok(ids[0] != null && ids[0] !== ids[1]);
});

test("once an element is captured in slices it is never captured whole, e.g. after it shrinks to fit", async () => {
  const { canvas, env } = await loadTall();
  await env.intersectCanvas(canvas);
  assert.equal(env.captures().length, 1);
  canvas.rect = { left: 0, top: 0, width: 1000, height: 1000 };
  await env.scroll();
  await env.fire(400);
  assert.equal(env.captures().length, 1);
});

test("the element's own badge (screenshots not allowed yet) goes away once its slices work", async () => {
  const canvas = makeCanvas();
  let allowed = false;
  const n = { count: 1 };
  const env = await load({
    canvases: [canvas],
    replies: { "am:capture": (m) => (m.probe ? (allowed ? { ok: true } : { ok: false, error: "capture_failed" }) : { ok: true, page: { ...page([null]), page_id: `S${n.count++}` } }) },
  });
  await env.intersectCanvas(canvas);
  assert.deepEqual(plain(env.badges.get(canvas).state), { phase: "error", error: "capture_failed" });
  allowed = true;
  await env.message({ type: "am:retry" });
  assert.equal(env.handles.length, 1);
  const own = env.badges.get(canvas);
  assert.ok(!own || own.destroyed || own.state === null, "no leftover badge on the element");
});

test("a tall unreadable <img> loses its 'can't load' badge once its slices work", async () => {
  const tall = () => ({ left: 0, top: 0, width: 800, height: 5000, right: 800, bottom: 5000 });
  const img = makeImg(SAME, { getBoundingClientRect: tall });
  const env = await load({ imgs: [img], replies: { "am:page": () => ({ ok: false, error: "fetch_failed" }), "am:capture": (m) => (m.probe ? { ok: true } : { ok: true, page: { ...page([null]), page_id: "T" } }) } });
  await env.intersect(img, {});
  assert.equal(env.handles.length, 1);
  const own = env.badges.get(img);
  assert.ok(!own || own.destroyed || own.state === null, "no leftover badge on the element");
});

test("an image whose src is set after the page was first observed is looked at again", async () => {
  const img = makeImg("", { currentSrc: "" }); // e.g. a blob: URL the reader creates once the data has arrived
  const env = await load({ imgs: [img] });
  assert.equal(env.observeLog.filter((e) => e === img).length, 1);
  img.src = "blob:https://reader.example/9-9-9";
  await env.mutate([{ type: "attributes", target: img }]);
  assert.equal(env.observeLog.filter((e) => e === img).length, 2, "observed again: the observer reports the new state");
});

test("an image waiting for host permission or for a retry is not started again by a src attribute touch", async () => {
  const waiting = makeImg(SAME + "?w");
  const failing = makeImg(SAME + "?f");
  const env = await load({
    imgs: [waiting, failing],
    replies: { "am:page": (m) => (m.imageUrl.endsWith("?w") ? { ok: false, error: "no_image_permission", host: "reader.example" } : { ok: false, error: "engine_error" }) },
  });
  await env.intersect(waiting, {});
  await env.intersect(failing, {});
  for (const img of [waiting, failing]) {
    const before = env.observeLog.filter((e) => e === img).length;
    await env.mutate([{ type: "attributes", target: img }]);
    assert.equal(env.observeLog.filter((e) => e === img).length, before, img.src);
  }
});

// --- a same-origin placeholder is not the real image --------------------------------------------------------------
// A lazy reader's <img>: its src is a placeholder image of the site until the real page is set.
const lazyPlaceholder = (w, h) =>
  placeholder({ src: "https://reader.example/placeholder.png", currentSrc: "https://reader.example/placeholder.png", complete: true, naturalWidth: w, naturalHeight: h });

test("a manga-sized placeholder is not the real image: no 'finding bubbles' while it is shown; after an error, no badge before the swap", async () => {
  const img = lazyPlaceholder(600, 860);
  const env = await load({ imgs: [img], replies: noPermission });
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1);
  assert.equal(env.badges.get(img), undefined, "nothing for the placeholder");
  assert.equal(env.ofType("am:missing-host").length, 0);
  await img.loaded(800, 1200);
  assert.deepEqual(plain(env.badges.get(img).state), { phase: "error", error: "no_image_permission" });
  assert.equal(env.ofType("am:missing-host").length, 1);
});

test("a success is drawn as soon as the image is laid out, whatever it shows", async () => {
  const img = lazyPlaceholder(600, 860);
  const env = await load({ imgs: [img], replies: { "am:page": () => ({ ok: true, page: page([null]) }) } });
  await env.intersect(img, {});
  assert.equal(env.handles.length, 1, "the engine read the real bytes");
  assert.equal(env.ofType("am:page").length, 1);
});

// A reader that leaves src at a resized image for good: it never equals data-src.
const resized = (w, h) => placeholder({ src: "https://reader.example/resized.jpg", currentSrc: "https://reader.example/resized.jpg", complete: true, naturalWidth: w, naturalHeight: h });

test("an <img> whose src differs from data-src for good: a success still draws the overlay", async () => {
  const img = resized(800, 1200);
  const env = await load({ imgs: [img], replies: { "am:page": () => ({ ok: true, page: page([null]) }) } });
  await env.intersect(img, {});
  assert.equal(env.handles.length, 1);
});

test("an <img> whose src differs from data-src for good: after an error, 3 s later a manga-sized src gets the badge", async () => {
  const img = resized(800, 1200);
  const env = await load({ imgs: [img], replies: noPermission });
  await env.intersect(img, {});
  assert.equal(env.badges.get(img), undefined, "waiting for a load event");
  await env.fire(3000);
  assert.deepEqual(plain(env.badges.get(img).state), { phase: "error", error: "no_image_permission" });
  assert.equal(env.ofType("am:missing-host").length, 1);
});

test("an <img> whose src differs from data-src for good: after an error, a small src is dropped silently", async () => {
  const img = resized(300, 250);
  const env = await load({ imgs: [img], replies: noPermission });
  await env.intersect(img, {});
  await env.fire(3000);
  assert.equal(env.badges.get(img)?.state ?? null, null);
  assert.equal(env.ofType("am:missing-host").length, 0);
  assert.equal(env.probes().length + env.captures().length, 0);
});

test("a small placeholder does not make the image a non-candidate", async () => {
  const img = lazyPlaceholder(100, 100);
  const env = await load({ imgs: [img] });
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1, "the real image is on its way, whatever the placeholder looks like");
});

test("a small placeholder followed by a small real image: no badge, no host request, no screenshot", async () => {
  const img = lazyPlaceholder(100, 100);
  const env = await load({ imgs: [img], replies: noPermission });
  await env.intersect(img, {});
  await img.loaded(300, 250);
  assert.equal(env.badges.get(img)?.state ?? null, null);
  assert.equal(env.ofType("am:missing-host").length, 0);
  assert.equal(env.probes().length + env.captures().length, 0);
});

// --- reading-speed trace (tools/perf): marks only while the harness has set globalThis.__amTrace ---------------------
const IMG_URL = "https://cdn.example/p1.jpg";
const names = (log, key) => log.filter((m) => !key || m.key === key).map((m) => m.name);

test("trace: a page's marks run observed -> fetch -> send -> reply -> overlay -> badge, keyed by the image URL", async () => {
  const env = await load({ trace: true, fetch: () => true, replies: { "am:page": () => ({ ok: true, page: page([null, null]) }) } });
  await env.intersect(env.imgs[0], {});
  const seq = names(env.log, IMG_URL);
  for (const [a, b] of [["observed", "fetch:start"], ["fetch:start", "fetch:headers"], ["fetch:headers", "fetch:data"], ["fetch:data", "send"], ["send", "reply"], ["reply", "overlay"]]) {
    assert.ok(seq.indexOf(a) >= 0 && seq.indexOf(b) > seq.indexOf(a), `${a} before ${b}: ${seq}`);
  }
  const send = env.log.find((m) => m.name === "send");
  assert.equal(send.len, "data:image/png;fake,".length + IMG_URL.length, "the data URL length identifies the page in the offscreen log");
  assert.equal(env.log.find((m) => m.name === "reply").ok, true);
  const overlay = env.log.find((m) => m.name === "overlay");
  assert.deepEqual(plain({ pageId: overlay.pageId, bubbles: overlay.bubbles, known: overlay.known }), { pageId: "P", bubbles: 2, known: [] });
  assert.ok(env.log.every((m) => typeof m.t === "number"));
});

test("trace: badge states, bubble texts and the panel report are marked", async () => {
  const env = await load({ trace: true, replies: { "am:page": () => ({ ok: true, page: page([null, null]) }) } });
  await env.intersect(env.imgs[0], {});
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 0, text: "あ" });
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 1, text: "い" });
  const badges = env.log.filter((m) => m.name === "badge" && m.key === IMG_URL).map((m) => [m.phase, m.done, m.total]);
  assert.deepEqual(badges.slice(0, 2), [["detecting", undefined, undefined], ["ocr", 0, 2]]);
  assert.deepEqual(badges.at(-1), ["ocr", 2, 2]);
  assert.deepEqual(env.log.filter((m) => m.name === "text").map((m) => [m.pageId, m.bubbleId]), [["P", 0], ["P", 1]]);
  await env.fire(300);
  assert.equal(env.log.filter((m) => m.name === "report").length, 1);
});

test("trace: a failed reply is marked with ok: false and the error", async () => {
  const env = await load({ trace: true, fetch: () => true, replies: { "am:page": () => ({ ok: false, error: "no_image_permission", host: "cdn.example" }) } });
  await env.intersect(env.imgs[0], {});
  const reply = env.log.find((m) => m.name === "reply");
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "no_image_permission");
});

test("trace: without the harness flag nothing is recorded and no global appears", async () => {
  const env = await load({ replies: { "am:page": () => ({ ok: true, page: page([null]) }) } });
  await env.intersect(env.imgs[0], {});
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 0, text: "あ" });
  assert.equal(env.log, undefined);
  assert.equal(env.ofType("am:page").length, 1);
});

// --- visible page first: priorities for the engine, pages that left the zone ---------------------------------------------
const at = (top, height = 1200) => ({ getBoundingClientRect: () => ({ left: 0, top, width: 800, height, right: 800, bottom: top + height }) });
// innerHeight is 2000 in the sandbox: one viewport = 2000 px

test("priority: an am:page request carries how far its image is from the screen (0 = visible)", async () => {
  const env = await load({ imgs: [makeImg("https://cdn.example/p1.jpg", at(100)), makeImg("https://cdn.example/p2.jpg", at(3200))], fetch: () => true });
  await env.intersect(env.imgs[0], {});
  await env.intersect(env.imgs[1], {});
  const [a, b] = env.ofType("am:page").map((m) => plain(m.priority));
  assert.deepEqual([a.d, a.p], [0, 0]);
  assert.equal(b.d, 0.6); // 1200 px below the screen: 0.6 viewport
  assert.equal(b.p, 0.7); // off the screen: 0.1 + d, ahead of the (default) downward scroll: no penalty
  assert.ok(b.n > a.n, "reports are numbered");
});

test("priority: a page behind the scroll direction ranks a little worse than one at the same distance ahead", async () => {
  const env = await load({ imgs: [makeImg("https://cdn.example/p1.jpg", at(-3400)), makeImg("https://cdn.example/p2.jpg", at(4200))], fetch: () => true });
  await env.intersect(env.imgs[0], {});
  await env.intersect(env.imgs[1], {});
  const [above, below] = env.ofType("am:page").map((m) => plain(m.priority));
  assert.equal(above.d, below.d);
  assert.ok(above.p > below.p, "scrolling down: the page above is behind");
  env.window.scrollY = 500; // scrolled down...
  await env.scroll();
  env.window.scrollY = 100; // ...and now up
  await env.scroll();
  await env.fire(120);
  const items = plain(env.ofType("am:priorities").at(-1).items);
  const [aboveNow, belowNow] = [items.find((i) => i.key.endsWith("p1.jpg")), items.find((i) => i.key.endsWith("p2.jpg"))];
  assert.ok(aboveNow.p < belowNow.p, "scrolling up: the page above is ahead");
});

test("priority: a page already beyond 2 viewports when its bytes are ready is not sent (deferred), and is watched again", async () => {
  const img = makeImg("https://cdn.example/p1.jpg", at(6500)); // 4500 px = 2.25 viewports below the screen
  const env = await load({ imgs: [img], fetch: () => true });
  const seen = env.observeLog.length;
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 0);
  assert.equal(env.observeLog.length, seen, "not at once (see the backoff test)");
  await env.fire(250);
  assert.equal(env.observeLog.length, seen + 1, "the image is observed again");
  assert.equal(env.badges.get(img)?.state ?? null, null, "no badge, no error");
  // back near the screen: processed
  img.getBoundingClientRect = at(2500).getBoundingClientRect;
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1);
});

test("deferred: the engine dropped the request -> no badge, no error, forgotten, observed again, and sent again next time", async () => {
  let reply = { ok: false, error: "deferred" };
  const env = await load({ fetch: () => true, replies: { "am:page": () => reply } });
  const [img] = env.imgs;
  const seen = env.observeLog.length;
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1);
  await env.fire(250);
  assert.equal(env.observeLog.length, seen + 1);
  assert.ok(!env.badges.get(img) || env.badges.get(img).state === null, "the 'finding bubbles' badge is gone");
  assert.equal(env.ofType("am:missing-host").length, 0);
  assert.equal(env.captures().length + env.probes().length, 0, "not treated as an unreadable image");
  reply = { ok: true, page: page([null]) };
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 2, "a deferred request is not cached in results");
  assert.equal(env.handles.length, 1);
});

test("deferred never counts as failed in the summary", async () => {
  const env = await load({ fetch: () => true, replies: { "am:page": () => ({ ok: false, error: "deferred" }) } });
  await env.intersect(env.imgs[0], {});
  await env.fire(300);
  const states = [...env.badges.values()].map((b) => b.state).filter(Boolean);
  assert.deepEqual(states, []);
});

test("priorities: pending requests and unfinished pages are reported on scroll, throttled; finished pages are not", async () => {
  const done = makeImg("https://cdn.example/p1.jpg", at(100));
  const open = makeImg("https://cdn.example/p2.jpg", at(1400));
  const env = await load({
    imgs: [done, open],
    fetch: () => true,
    replies: { "am:page": (m) => ({ ok: true, page: m.imageUrl.endsWith("p1.jpg") ? { ...page([null]), page_id: "A" } : { ...page([null, null]), page_id: "B" } }) },
  });
  await env.intersect(done, {});
  await env.intersect(open, {});
  await env.message({ type: "am:bubble-text", pageId: "A", bubbleId: 0, text: "あ" }); // page A is finished
  await env.scroll();
  await env.scroll();
  assert.equal(env.pendingTimers(120).length, 1, "one timer however many scroll events");
  await env.fire(120);
  const msgs = env.ofType("am:priorities");
  assert.equal(msgs.length, 1);
  assert.deepEqual(plain(msgs[0].items).map((i) => i.key), ["https://cdn.example/p2.jpg"]);
  assert.ok(Number.isFinite(msgs[0].items[0].d) && Number.isFinite(msgs[0].items[0].p) && Number.isFinite(msgs[0].items[0].n));
});

test("priorities: nothing is sent when there is nothing to report", async () => {
  const env = await load({ imgs: [] });
  await env.scroll();
  await env.fire(120);
  assert.equal(env.ofType("am:priorities").length, 0);
});

test("priority: on the screen the most visible page ranks first (below 0.1), off the screen 0.1 + distance", async () => {
  // viewport 2000 px high
  const env = await load({
    imgs: [makeImg("https://cdn.example/a.jpg", at(0, 1900)), makeImg("https://cdn.example/b.jpg", at(1940, 1900)), makeImg("https://cdn.example/c.jpg", at(3900, 1900))],
    fetch: () => true,
  });
  for (const img of env.imgs) await env.intersect(img, {});
  const [a, b, c] = env.ofType("am:page").map((m) => plain(m.priority));
  assert.equal(a.p, 0); // all of it is on the screen
  assert.ok(b.p > a.p && b.p < 0.1, "a sliver of the next page: on the screen, but behind the full page");
  assert.deepEqual([a.d, b.d, c.d], [0, 0, 0.95]);
  assert.equal(c.p, 1.05);
});

test("priority: reports are numbered so that a reloaded page's first report is newer than any report of the copy before it", async () => {
  const before = await load({ now: 1000, fetch: () => true });
  await before.intersect(before.imgs[0], {});
  const after = await load({ now: 2000, fetch: () => true });
  await after.intersect(after.imgs[0], {});
  assert.ok(after.ofType("am:page")[0].priority.n > before.ofType("am:page")[0].priority.n);
});

// --- review fixes ---------------------------------------------------------------------------------------------------
test("priority: one n per report, however many items; the next report is newer, and n never falls behind the clock", async () => {
  const imgs = [1, 2, 3].map((i) => makeImg(`https://cdn.example/p${i}.jpg`, at(100 * i)));
  const env = await load({ imgs, fetch: () => true, now: 5000, replies: { "am:page": () => new Promise(() => {}) } }); // requests stay pending
  for (const img of imgs) await env.intersect(img, {});
  const sentN = env.ofType("am:page").map((m) => m.priority.n);
  assert.deepEqual(sentN, [5001, 5002, 5003], "the clock stands still: +1 per report");
  await env.scroll();
  await env.fire(120);
  const batch = env.ofType("am:priorities").at(-1).items;
  assert.equal(new Set(batch.map((i) => i.n)).size, 1, "one n for the whole batch");
  assert.equal(batch[0].n, 5004, "a batch of three used one number, not three");
});

test("priority: n follows the clock when it moves ahead of the counter", async () => {
  const env = await load({ now: 1000, fetch: () => true });
  await env.intersect(env.imgs[0], {});
  assert.equal(env.ofType("am:page")[0].priority.n, 1001);
});

test("priority: a zero-size or hidden image ranks far (behind everything in the zone), but is not 'far' enough to be deferred", async () => {
  const hidden = makeImg("https://cdn.example/h.jpg", { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) });
  const sliver = makeImg("https://cdn.example/s.jpg", at(100, 1));
  const shown = makeImg("https://cdn.example/v.jpg", at(100));
  const edge = makeImg("https://cdn.example/e.jpg", at(5800)); // 1.9 viewports below
  const env = await load({ imgs: [hidden, sliver, shown, edge], fetch: () => true });
  for (const img of env.imgs) await env.intersect(img, {});
  const by = Object.fromEntries(env.ofType("am:page").map((m) => [m.imageUrl.slice(-5, -4), plain(m.priority)]));
  assert.equal(by.h.d <= 2, true, "still sent");
  assert.ok(by.h.p > by.e.p && by.s.p > by.e.p, "behind a page 1.9 viewports away");
  assert.ok(by.h.p > by.v.p);
});

test("deferred: the image is observed again after a pause that grows with every deferral, so a page cannot loop at full speed", async () => {
  const env = await load({ fetch: () => true, replies: { "am:page": () => ({ ok: false, error: "deferred" }) } });
  const [img] = env.imgs;
  const seen = env.observeLog.length;
  await env.intersect(img, {});
  assert.equal(env.observeLog.length, seen, "no immediate re-observe");
  assert.equal(env.pendingTimers(250).length, 1);
  await env.fire(250);
  await env.intersect(img, {}); // fires at once, still deferred
  assert.equal(env.pendingTimers(250).length, 0);
  assert.equal(env.pendingTimers(1200).length, 1, "longer the second time");
  await env.fire(1200);
  await env.intersect(img, {});
  assert.equal(env.pendingTimers(3500).length, 1);
  assert.equal(env.ofType("am:page").length, 3);
});

test("deferred: a page beyond the zone is turned down before its bytes are fetched", async () => {
  const img = makeImg("https://cdn.example/p1.jpg", at(9000));
  const env = await load({ imgs: [img], fetch: () => true });
  await env.intersect(img, {});
  assert.deepEqual(env.fetched, [], "no fetch, no data URL");
});

test("priorities: only requests in flight and unfinished pages are reported, nearest first, at most 100", async () => {
  // all below the screen (2000 px high), each 20 px farther than the one before
  const imgs = Array.from({ length: 130 }, (_, i) => makeImg(`https://cdn.example/p${String(i).padStart(3, "0")}.jpg`, at(2100 + i * 20, 1000)));
  const env = await load({ imgs, fetch: () => true, replies: { "am:page": () => new Promise(() => {}) } });
  for (const img of [...imgs].reverse()) await env.intersect(img, {}); // arrival order is not distance order
  await env.scroll();
  await env.fire(120);
  const items = plain(env.ofType("am:priorities").at(-1).items);
  assert.equal(items.length, 100);
  assert.deepEqual(items.map((i) => i.key), imgs.slice(0, 100).map((i) => i.src), "the 100 nearest, nearest first");
});

test("priorities: rects are measured only for pending pages, not for the finished ones of a long chapter", async () => {
  let measured = 0;
  const imgs = Array.from({ length: 300 }, (_, i) => makeImg(`https://cdn.example/q${i}.jpg`, { getBoundingClientRect: () => (measured++, { left: 0, top: 2100 + i * 10, width: 800, height: 1000, right: 800, bottom: 3100 + i * 10 }) }));
  const finished = new Set(imgs.slice(150).map((i) => i.src)); // 150 pages that are completely done
  const env = await load({
    imgs,
    fetch: () => true,
    replies: { "am:page": (m) => (finished.has(m.imageUrl) ? { ok: true, page: { ...page([null]), page_id: m.imageUrl } } : new Promise(() => {})) },
  });
  for (const img of imgs) await env.intersect(img, {});
  for (const url of finished) await env.message({ type: "am:bubble-text", pageId: url, bubbleId: 0, text: "あ" });
  measured = 0;
  await env.scroll();
  await env.fire(120);
  assert.equal(measured, 150);
  assert.equal(env.ofType("am:priorities").at(-1).items.length, 100);
});

test("priorities: in on-demand mode a page whose engine work is done (bubbles known, texts only on hover) is not reported", async () => {
  const a = makeImg("https://cdn.example/a.jpg", at(100));
  const b = makeImg("https://cdn.example/b.jpg", at(1400));
  const env = await load({
    imgs: [a, b],
    fetch: () => true,
    replies: { "am:perf-mode": () => ({ ok: true, mode: "on-demand" }), "am:page": (m) => (m.imageUrl.endsWith("a.jpg") ? { ok: true, page: { ...page([null, null]), page_id: "A" } } : new Promise(() => {})) },
  });
  await env.intersect(a, { intersectionRatio: 1 });
  await env.intersect(b, { intersectionRatio: 1 });
  await env.scroll();
  await env.fire(120);
  assert.deepEqual(plain(env.ofType("am:priorities").at(-1).items).map((i) => i.key), ["https://cdn.example/b.jpg"]);
});

test("a throw from sendMessage itself (the extension was reloaded) is an extension_reloaded reply, not a cached rejected promise", async () => {
  let broken = true;
  const [a, b] = [makeImg("https://cdn.example/same.jpg", at(100)), makeImg("https://cdn.example/same.jpg", at(150))];
  const env = await load({ imgs: [a, b], fetch: () => true, syncThrow: (m) => broken && m.type === "am:page" });
  await env.intersect(a, {});
  assert.equal(env.badges.get(a)?.state?.error, "extension_reloaded");
  broken = false;
  await env.intersect(b, {}); // the same page: must ask again, not reuse the failure
  assert.equal(env.ofType("am:page").length, 1);
  assert.equal(env.handles.length, 1);
});

test("a late failed reply does not remove a newer cached request of the same page", async () => {
  const URL_ = "https://cdn.example/same.jpg";
  const [b, a, c] = [makeImg(URL_, at(100)), makeImg(URL_, at(120)), makeImg(URL_, at(140))];
  let calls = 0;
  let releaseA;
  const env = await load({
    imgs: [b, a, c],
    fetch: () => true,
    replies: { "am:page": () => (++calls === 1 ? { ok: false, error: "models_downloading" } : calls === 2 ? new Promise((r) => (releaseA = r)) : new Promise(() => {})) },
  });
  await env.intersect(b, {}); // fails, retried in 2 s
  await env.intersect(a, {}); // a new request, slow
  await env.fire(2000); // b retries: its request replaces a's in the cache
  releaseA({ ok: false, error: "no_manga" }); // a's late failure
  await env.message({ type: "noop" }); // let it land
  await env.intersect(c, {}); // must reuse b's request
  assert.equal(env.ofType("am:page").length, 3);
});

// A carousel or a loading overlay moves pages without a scroll event; what the engine was told must follow.
test("priorities: while requests are pending the report is repeated without any scroll, and only for pages whose rank changed", async () => {
  const rects = { a: at(100), b: at(2100, 1000) };
  const a = makeImg("https://cdn.example/a.jpg", { getBoundingClientRect: () => rects.a.getBoundingClientRect() });
  const b = makeImg("https://cdn.example/b.jpg", { getBoundingClientRect: () => rects.b.getBoundingClientRect() });
  const env = await load({ imgs: [a, b], fetch: () => true, replies: { "am:page": () => new Promise(() => {}) } });
  await env.intersect(a, {});
  await env.intersect(b, {});
  await env.fire(120); // the first report, scheduled by the requests
  assert.equal(env.ofType("am:priorities").length, 1);
  await env.fire(400); // nothing moved: nothing to say
  assert.equal(env.ofType("am:priorities").length, 1);
  rects.a = at(6000, 1200); // the carousel slid the page away; no scroll event
  await env.fire(400);
  const last = plain(env.ofType("am:priorities").at(-1).items);
  assert.deepEqual(last.map((i) => i.key), ["https://cdn.example/a.jpg"], "only the page that changed");
  assert.ok(last[0].d > 1.9);
});

test("priorities: the repeat stops when nothing is pending", async () => {
  const env = await load({ fetch: () => true });
  await env.intersect(env.imgs[0], {}); // answered at once, no bubbles to wait for? one bubble without text: pending
  await env.message({ type: "am:bubble-text", pageId: "P", bubbleId: 0, text: "あ" });
  await env.fire(120);
  assert.equal(env.pendingTimers(400).length, 0);
});

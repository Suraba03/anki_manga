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
async function load({ imgs = [makeImg()], canvases = [], replies: given = {}, fetch: fetchImpl = () => { throw new TypeError("Failed to fetch"); }, canvas = "tainted", blobSize = 1000 } = {}) {
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
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME, dataUrl: fake(SAME) }]);
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
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME }]);
});

test("the canvas copy is only made of the image the <img> shows: a placeholder under data-src is not copied", async () => {
  const real = "https://cdn.example/real.jpg";
  const img = makeImg("https://reader.example/placeholder.png", { dataset: { src: real }, currentSrc: "https://reader.example/placeholder.png", naturalWidth: 600, naturalHeight: 860 });
  const env = await load({ imgs: [img], fetch: () => { throw new TypeError("network"); }, canvas: "ok" });
  await env.intersect(img, {});
  assert.equal(env.drawn.length, 0);
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: real }]);
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
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME }]);
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
  assert.deepEqual(plain(bare.ofType("am:page")), [{ type: "am:page", imageUrl: SAME }]);
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
  assert.deepEqual(plain(env.ofType("am:page")), [{ type: "am:page", imageUrl: SAME }]);
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

test("a manga-sized placeholder is not the real image: no badge until the page is laid out; then the page is drawn", async () => {
  const img = lazyPlaceholder(600, 860);
  const env = await load({ imgs: [img], replies: { "am:page": () => ({ ok: true, page: page([null]) }) } });
  await env.intersect(img, {});
  assert.equal(env.ofType("am:page").length, 1);
  assert.equal(env.badges.get(img), undefined, "no 'finding bubbles' for the placeholder");
  assert.equal(env.handles.length, 0);
  await img.loaded(800, 1200);
  assert.equal(env.handles.length, 1);
  assert.deepEqual(plain(env.badges.get(img).state), { phase: "ocr", done: 0, total: 1 });
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

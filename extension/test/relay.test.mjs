import test from "node:test";
import assert from "node:assert/strict";

// Chrome stub for the service worker's message relay. Records every message sent to tabs and to the offscreen document.
const toTabs = [];
const toOffscreen = [];
const listeners = [];
const store = { local: {}, session: {} };
let offscreenOpen = true;
let granted = true;
let engineReply = (msg) => ({ ok: true });
let screenshot;
let manifest = { name: "x" }; // an unpacked extension has no update_url

const area = (data) => ({
  remove: async (key) => delete data[key],
  get: async (key) => (typeof key === "string" ? (key in data ? { [key]: structuredClone(data[key]) } : {}) : { ...data }),
  set: async (obj) => Object.assign(data, structuredClone(obj)),
});
const noEvents = { addListener() {} };
globalThis.chrome = {
  runtime: {
    id: "ext",
    getManifest: () => manifest,
    onInstalled: noEvents,
    onStartup: noEvents,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      toOffscreen.push(msg);
      return engineReply(msg);
    },
    getContexts: async () => (offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
  },
  offscreen: { createDocument: async () => {} },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  tabs: {
    onRemoved: noEvents,
    onUpdated: noEvents,
    query: async () => [],
    sendMessage: async (tabId, msg) => {
      toTabs.push([tabId, msg]);
    },
    captureVisibleTab: async () => screenshot,
  },
  permissions: { contains: async () => granted },
  storage: { local: area(store.local), session: area(store.session) },
  scripting: {},
};

// Loads a fresh copy of the service worker (module state such as `watchers` starts empty, like after a restart)
// and returns a function that sends it a runtime message the way Chrome does.
async function startWorker(tag) {
  await import(`../background.js?${tag}`);
  const listener = listeners.at(-1);
  return (msg, sender = {}) =>
    new Promise((resolve) => {
      const async = listener(msg, sender, resolve);
      if (async !== true) resolve(undefined);
    });
}
const tab = (id) => ({ tab: { id, windowId: 1 } });
const reset = () => {
  toTabs.length = toOffscreen.length = 0;
  engineReply = () => ({ ok: true });
  granted = true;
  for (const k of Object.keys(store.session)) delete store.session[k];
  for (const k of Object.keys(store.local)) delete store.local[k];
};
const textMsg = (pageId, bubbleId, text) => ({ type: "eng:text", pageId, bubbleId, text });

test("two tabs watching one page both receive its bubble text", async () => {
  reset();
  const send = await startWorker("two");
  await send({ type: "am:watch", pageId: "P" }, tab(1));
  await send({ type: "am:watch", pageId: "P" }, tab(2));
  await send({ type: "am:watch", pageId: "Q" }, tab(3));
  await send(textMsg("P", 4, "こんにちは"));
  assert.deepEqual(toTabs.sort((a, b) => a[0] - b[0]), [
    [1, { type: "am:bubble-text", pageId: "P", bubbleId: 4, text: "こんにちは" }],
    [2, { type: "am:bubble-text", pageId: "P", bubbleId: 4, text: "こんにちは" }],
  ]);
});

test("a watching tab is registered once, and text with no watchers is dropped", async () => {
  reset();
  const send = await startWorker("dedupe");
  await send({ type: "am:watch", pageId: "P" }, tab(1));
  await send({ type: "am:watch", pageId: "P" }, tab(1));
  await send(textMsg("P", 0, "a"));
  assert.equal(toTabs.length, 1);
  toTabs.length = 0;
  assert.deepEqual(await send(textMsg("nobody", 0, "x")), { ok: true });
  assert.equal(toTabs.length, 0);
});

test("eng:text is accepted only from the extension itself, not from a tab", async () => {
  reset();
  const send = await startWorker("sender");
  await send({ type: "am:watch", pageId: "P" }, tab(1));
  await send(textMsg("P", 0, "forged"), tab(9));
  assert.equal(toTabs.length, 0);
});

test("after a service-worker restart a hover re-registers the watcher and the next text arrives", async () => {
  reset();
  const before = await startWorker("restart-1");
  await before({ type: "am:watch", pageId: "P" }, tab(5));
  // The worker is torn down: all in-memory watchers are gone. OCR keeps running in the offscreen document.
  const send = await startWorker("restart-2");
  await send(textMsg("P", 1, "lost"));
  assert.equal(toTabs.length, 0, "no watchers after the restart");

  // The content script's hover handler sends prioritize + watch for a bubble without text.
  await send({ type: "am:prioritize", pageId: "P", bubbleId: 2 }, tab(5));
  await send({ type: "am:watch", pageId: "P" }, tab(5));
  assert.deepEqual(toOffscreen.at(-1), { target: "offscreen", type: "eng:prioritize", pageId: "P", bubbleId: 2 });

  await send(textMsg("P", 2, "next"));
  assert.deepEqual(toTabs, [[5, { type: "am:bubble-text", pageId: "P", bubbleId: 2, text: "next" }]]);
});

test("a text that was already known comes back with the prioritize reply and goes to that tab", async () => {
  reset();
  engineReply = (msg) => (msg.type === "eng:prioritize" ? { ok: true, text: "known" } : { ok: true });
  const send = await startWorker("known");
  const reply = await send({ type: "am:prioritize", pageId: "P", bubbleId: 7 }, tab(4));
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(toTabs, [[4, { type: "am:bubble-text", pageId: "P", bubbleId: 7, text: "known" }]]);
});

test("am:page checks image-host permission, then asks the engine to OCR everything (prefetch)", async () => {
  reset();
  const send = await startWorker("page");
  granted = false;
  const denied = await send({ type: "am:page", imageUrl: "https://cdn.example/p1.jpg" }, tab(1));
  assert.deepEqual(denied, { ok: false, error: "no_image_permission", host: "cdn.example" });
  assert.deepEqual(store.session.missingHosts, { 1: ["cdn.example"] });
  assert.equal(toOffscreen.length, 0);

  granted = true;
  engineReply = () => ({ ok: true, page: { page_id: "P", width: 1, height: 1, bubbles: [] } });
  const ok = await send({ type: "am:page", imageUrl: "https://cdn.example/p1.jpg" }, tab(1));
  assert.equal(ok.ok, true);
  assert.deepEqual(toOffscreen.at(-1), {
    target: "offscreen",
    type: "eng:page",
    source: { url: "https://cdn.example/p1.jpg" },
    ocr: "all",
  });
});

test("on-demand mode (setting or benchmark) asks for no prefetch OCR", async () => {
  reset();
  const send = await startWorker("ondemand");
  store.local.settings = { perfMode: "on-demand" };
  await send({ type: "am:page", imageUrl: "https://cdn.example/p.jpg" }, tab(1));
  assert.equal(toOffscreen.at(-1).ocr, "none");

  store.local.settings = { perfMode: "auto" };
  store.session.modelStatus = { state: "ready", progress: 1, ep: "wasm", mode: "on-demand" };
  await send({ type: "am:page", imageUrl: "https://cdn.example/p.jpg" }, tab(1));
  assert.equal(toOffscreen.at(-1).ocr, "none");

  store.local.settings = { perfMode: "prefetch" };
  await send({ type: "am:page", imageUrl: "https://cdn.example/p.jpg" }, tab(1));
  assert.equal(toOffscreen.at(-1).ocr, "all");
});

test("am:capture sends the screenshot and the crop rectangle in device pixels", async () => {
  reset();
  // 8-byte PNG signature + IHDR header of a 2000x1000 image.
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12);
  png.writeUInt32BE(2000, 16);
  png.writeUInt32BE(1000, 20);
  screenshot = `data:image/png;base64,${png.toString("base64")}`;
  const send = await startWorker("capture");
  await send({ type: "am:capture", rect: { x: 10, y: 20, width: 300, height: 400 }, viewportWidth: 1000 }, tab(1));
  assert.deepEqual(toOffscreen.at(-1), {
    target: "offscreen",
    type: "eng:page",
    source: { dataUrl: screenshot, crop: { x: 10, y: 20, width: 300, height: 400, scale: 2 } },
    ocr: "all",
  });
});

test("am:prioritize and am:engine are forwarded to the offscreen document", async () => {
  reset();
  const send = await startWorker("forward");
  await send({ type: "am:engine", msg: { type: "eng:status" } });
  assert.deepEqual(toOffscreen.at(-1), { target: "offscreen", type: "eng:status" });
});

// Offscreen documents have no chrome.storage: the engine host asks the worker to read and write for it.
test("the worker mirrors the engine's model status and benchmark into storage (offscreen only)", async () => {
  reset();
  const send = await startWorker("mirror");
  const status = { state: "ready", progress: 1, ep: "wasm", mode: "prefetch" };
  assert.deepEqual(await send({ type: "eng:model-status", status }), { ok: true });
  assert.deepEqual(store.session.modelStatus, status);
  await send({ type: "eng:model-status", status: { state: "error" } }, tab(3));
  assert.deepEqual(store.session.modelStatus, status, "a content script cannot write it");

  await send({ type: "eng:benchmark", benchmark: { msPerPage: 5, mode: "prefetch", ep: "wasm" } });
  assert.deepEqual(store.local.benchmark, { msPerPage: 5, mode: "prefetch", ep: "wasm" });
  await send({ type: "eng:benchmark", benchmark: null });
  assert.equal("benchmark" in store.local, false);
});

test("devModelBase is handed to the engine only for an unpacked extension", async () => {
  reset();
  const send = await startWorker("devbase");
  assert.deepEqual(await send({ type: "eng:dev-config" }), { devModelBase: null });
  store.local.devModelBase = "http://127.0.0.1:47900/models/";
  assert.deepEqual(await send({ type: "eng:dev-config" }), { devModelBase: "http://127.0.0.1:47900/models/" });
  manifest = { name: "x", update_url: "https://clients2.google.com/service/update2/crx" };
  assert.deepEqual(await send({ type: "eng:dev-config" }), { devModelBase: null });
  manifest = { name: "x" };
});

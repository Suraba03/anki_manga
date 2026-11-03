import test from "node:test";
import assert from "node:assert/strict";

// Chrome stub for the service worker's message relay. Records every message sent to tabs and to the offscreen document.
const toTabs = [];
const toOffscreen = [];
const listeners = [];
const tabEvents = { removed: [], updated: [] };
const store = { local: {}, session: {} };
let offscreenOpen = true;
let granted = true;
let engineReply = (msg) => ({ ok: true });
let screenshot;
let manifest = { name: "x" }; // an unpacked extension has no update_url
let tabsAt = {}; // match pattern -> tabs returned by chrome.tabs.query
const accessLevels = [];
const storageChanged = [];

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
    onRemoved: { addListener: (fn) => tabEvents.removed.push(fn) },
    onUpdated: { addListener: (fn) => tabEvents.updated.push(fn) },
    query: async ({ url }) => tabsAt[url] || [],
    sendMessage: async (tabId, msg) => {
      toTabs.push([tabId, msg]);
    },
    captureVisibleTab: async () => screenshot,
  },
  permissions: { contains: async () => granted },
  storage: {
    local: { ...area(store.local), setAccessLevel: async (opts) => accessLevels.push(opts) },
    session: area(store.session),
    onChanged: { addListener: (fn) => storageChanged.push(fn) },
  },
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
  tabsAt = {};
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

test("after a service-worker restart the persisted watchers still receive the next text", async () => {
  reset();
  const before = await startWorker("restart-1");
  await before({ type: "am:watch", pageId: "P" }, tab(5));
  await before({ type: "am:watch", pageId: "P" }, tab(6));
  // The worker is torn down: module state is gone, session storage survives. OCR keeps running in the offscreen document.
  const send = await startWorker("restart-2");
  await send(textMsg("P", 1, "kept"));
  assert.deepEqual(toTabs.map(([id]) => id).sort(), [5, 6], "both tabs, without a new hover");
  assert.equal(toTabs[0][1].text, "kept");
});

test("after a restart a hover still re-requests: prioritize is sent and the watcher is (re-)registered", async () => {
  reset();
  const before = await startWorker("hover-1");
  await before({ type: "am:watch", pageId: "P" }, tab(5));
  const send = await startWorker("hover-2");
  await send({ type: "am:prioritize", pageId: "P", bubbleId: 2 }, tab(5));
  await send({ type: "am:watch", pageId: "P" }, tab(5));
  // am:watch now also asks the engine for the page's finished texts (eng:texts), so prioritize is no longer the last message.
  assert.deepEqual(toOffscreen.filter((m) => m.type === "eng:prioritize").at(-1), { target: "offscreen", type: "eng:prioritize", pageId: "P", bubbleId: 2 });
  await send(textMsg("P", 2, "next"));
  assert.deepEqual(toTabs, [[5, { type: "am:bubble-text", pageId: "P", bubbleId: 2, text: "next" }]]);
});

test("watchers are pruned when a tab is closed or starts navigating", async () => {
  reset();
  const send = await startWorker("prune");
  await send({ type: "am:watch", pageId: "P" }, tab(1));
  await send({ type: "am:watch", pageId: "P" }, tab(2));
  await send({ type: "am:watch", pageId: "Q" }, tab(3));
  await tabEvents.removed.at(-1)(1);
  await tabEvents.updated.at(-1)(3, { status: "loading" });
  await tabEvents.updated.at(-1)(2, { status: "complete" }); // not a navigation
  await send(textMsg("P", 0, "a"));
  await send(textMsg("Q", 0, "b"));
  assert.deepEqual(toTabs, [[2, { type: "am:bubble-text", pageId: "P", bubbleId: 0, text: "a" }]]);
  // The pruning is persisted too: a restarted worker does not resurrect the closed tabs.
  toTabs.length = 0;
  const after = await startWorker("prune-2");
  await after(textMsg("P", 1, "c"));
  await after(textMsg("Q", 1, "d"));
  assert.deepEqual(toTabs.map(([id]) => id), [2]);
});

test("am:engine is for extension pages only; a content script is refused", async () => {
  reset();
  const send = await startWorker("engine-guard");
  assert.deepEqual(await send({ type: "am:engine", msg: { type: "eng:clear" } }, tab(1)), { ok: false });
  assert.equal(toOffscreen.length, 0);
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
  assert.equal(store.session.missingHosts, undefined, "the host is noted when the content script reports it (am:missing-host)");
  await send({ type: "am:missing-host", host: "cdn.example" }, tab(1));
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

// --- final review fixes ---------------------------------------------------------------------

test("am:watch replays the texts the engine already finished for that page, to the watching tab only", async () => {
  reset();
  engineReply = (msg) =>
    msg.type === "eng:texts"
      ? { ok: true, texts: [{ bubbleId: 0, text: "あ" }, { bubbleId: 2, text: "い" }] }
      : { ok: true };
  const send = await startWorker("replay");
  await send({ type: "am:watch", pageId: "P" }, tab(7));
  assert.deepEqual(toOffscreen.at(-1), { target: "offscreen", type: "eng:texts", pageId: "P" });
  assert.deepEqual(toTabs, [
    [7, { type: "am:bubble-text", pageId: "P", bubbleId: 0, text: "あ" }],
    [7, { type: "am:bubble-text", pageId: "P", bubbleId: 2, text: "い" }],
  ]);
});

test("a tab that is already registered gets the replay again when it re-attaches the page (revisit)", async () => {
  reset();
  engineReply = (msg) => (msg.type === "eng:texts" ? { ok: true, texts: [{ bubbleId: 1, text: "う" }] } : { ok: true });
  const send = await startWorker("revisit");
  await send({ type: "am:watch", pageId: "P" }, tab(7));
  toTabs.length = 0;
  await send({ type: "am:watch", pageId: "P" }, tab(7));
  assert.deepEqual(toTabs, [[7, { type: "am:bubble-text", pageId: "P", bubbleId: 1, text: "う" }]]);
});

test("a failing engine lookup does not break am:watch", async () => {
  reset();
  engineReply = () => {
    throw new Error("offscreen gone");
  };
  const send = await startWorker("replay-fail");
  assert.deepEqual(await send({ type: "am:watch", pageId: "P" }, tab(7)), { ok: true });
  await send(textMsg("P", 0, "later"));
  assert.equal(toTabs.length, 1, "the watcher is still registered");
});

test("am:perf-mode hands a content script the effective mode only, never the settings or the API key", async () => {
  reset();
  const send = await startWorker("perf");
  store.local.settings = { perfMode: "auto", installId: "i", llm: { mode: "own", apiKey: "sk-secret", baseUrl: "https://x.example" } };
  assert.deepEqual(await send({ type: "am:perf-mode" }, tab(1)), { ok: true, mode: "prefetch" });
  store.local.benchmark = { msPerPage: 9000, mode: "on-demand", ep: "wasm" };
  assert.deepEqual(await send({ type: "am:perf-mode" }, tab(1)), { ok: true, mode: "on-demand" });
  store.local.settings.perfMode = "prefetch";
  const reply = await send({ type: "am:perf-mode" }, tab(1));
  assert.deepEqual(reply, { ok: true, mode: "prefetch" });
  assert.ok(!JSON.stringify(reply).includes("sk-secret"));
});

test("a settings change is pushed to the tabs of enabled sites as the mode only (no API key)", async () => {
  reset();
  await startWorker("perf-push");
  store.local.enabledOrigins = ["https://reader.example"];
  store.local.settings = { perfMode: "on-demand", llm: { apiKey: "sk-secret" } };
  tabsAt["https://reader.example/*"] = [{ id: 3 }, { id: 4 }];
  const changed = storageChanged.at(-1);
  await changed({ settings: { newValue: store.local.settings } }, "local");
  await changed({ somethingElse: {} }, "local"); // ignored
  await changed({ settings: { newValue: {} } }, "session"); // ignored
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(toTabs, [
    [3, { type: "am:perf-mode", mode: "on-demand" }],
    [4, { type: "am:perf-mode", mode: "on-demand" }],
  ]);
  assert.ok(!JSON.stringify(toTabs).includes("sk-secret"));
});

test("storage.local is closed to content scripts (trusted contexts only) every time the worker starts", async () => {
  reset();
  accessLevels.length = 0;
  await startWorker("access");
  assert.deepEqual(accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
});

test("when the engine becomes ready, tabs of enabled sites are told to retry their failed pages", async () => {
  reset();
  const send = await startWorker("ready-retry");
  store.local.enabledOrigins = ["https://reader.example"];
  tabsAt["https://reader.example/*"] = [{ id: 3 }];
  await send({ type: "eng:model-status", status: { state: "downloading", progress: 0.5 } });
  assert.equal(toTabs.length, 0);
  await send({ type: "eng:model-status", status: { state: "ready", progress: 1, ep: "wasm", mode: "prefetch" } });
  assert.deepEqual(toTabs, [[3, { type: "am:retry" }]]);
  toTabs.length = 0;
  await send({ type: "eng:model-status", status: { state: "ready", progress: 1 } }, tab(9)); // forged by a tab
  assert.equal(toTabs.length, 0);
});

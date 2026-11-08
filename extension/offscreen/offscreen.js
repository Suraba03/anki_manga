// Offscreen engine host: runs the OCR models (onnxruntime-web) for the service worker.
// Messages from the SW carry target:"offscreen"; everything else is ignored.
import * as ort from "../vendor/ort/ort.webgpu.min.mjs";
import { buildModelSets, ensureFiles, clearModels } from "../engine/models.js";
import { configureOrt } from "../engine/runtime.js";
import { startEngine } from "../engine/startup.js";
import { busyReply } from "../engine/busy.js";
import { pageGate, resolveScope, retireEngine, waitPrepared } from "../engine/gate.js";
import { openStore } from "../engine/store.js";
import { OcrScheduler } from "../engine/scheduler.js";
import { createTokenizer } from "../lib/tokenizer.js";
import { bubbleReply } from "../engine/bubble.js";
import { findPanelBox, cropJpeg } from "../engine/panel-crop.js";
import { Dictionary } from "../lib/dictionary.js";
import { acceptSender, engineHandlers, isDevBuild } from "../engine/trust.js";

configureOrt(ort);

const ANKI_URL = "http://127.0.0.1:8765";

async function probeWebgpu() {
  if (!navigator.gpu) return { ok: false, error: "navigator.gpu is unavailable" };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ok: false, error: "no WebGPU adapter" };
  const info = adapter.info || {};
  const session = await ort.InferenceSession.create(chrome.runtime.getURL("test/fixtures/add.onnx"), {
    executionProviders: ["webgpu"],
  });
  const feeds = {
    a: new ort.Tensor("float32", Float32Array.of(1), [1]),
    b: new ort.Tensor("float32", Float32Array.of(2), [1]),
  };
  const out = await session.run(feeds);
  await session.release();
  return { ok: out.c.data[0] === 3, adapter: [info.vendor, info.architecture, info.description].filter(Boolean).join("/") };
}

async function probeFetch(msg) {
  const resp = await fetch(msg.url);
  const bytes = (await resp.arrayBuffer()).byteLength;
  return { ok: resp.ok, status: resp.status, bytes };
}

async function probeAnki() {
  const resp = await fetch(ANKI_URL, { method: "POST", body: JSON.stringify({ action: "version", version: 6 }) });
  return { ok: resp.ok, result: (await resp.json()).result };
}

// --- engine: models, status, page pipeline ---------------------------------------------
const MODEL_CACHE = "anki-manga-models";
const MIN_SIDE = 400;
const MIN_LONG_SIDE = 600;
// A page request waits this long for the warm-up and speed check before it is told to retry (models_loading). Its
// badge reads "finding bubbles…" meanwhile, as before the gate; WebGPU settles in ~2-3 s, and a shorter wait would
// hand slow WASM machines to the content script's retry timers (up to 15 s), so 10 s is the trade-off.
const PREPARE_WAIT_MS = 10000;
const PAGES_IN_MEMORY = 6; // decoded pages kept for on-demand OCR (about 7 MB each)

let status = { state: "downloading", progress: 0 };
let persistedProgress = -1;
let engine = null;
let preparing = null; // settles when the engine's background work (warm-up, speed check) is done; callers re-check the gate
let prepared = null; // the benchmark once the engine's warm-up and speed check are done (pages wait for it)
let store = null;
let booting = null;
const decoded = new Map(); // pageId -> rgba, least recently used first

// An offscreen document only has chrome.runtime: storage reads and writes go through the service worker.
const toWorker = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// Mirrors the status into chrome.storage.session (the panel and the service worker read it). Download
// progress arrives per network chunk, so only whole-percent steps are written.
function setStatus(next) {
  status = { ...status, error: undefined, ...next };
  if (next.state === "downloading" && next.progress < 1 && next.progress - persistedProgress < 0.01 && next.progress > 0) return;
  persistedProgress = next.progress;
  toWorker({ type: "eng:model-status", status });
}

// Development only: an unpacked extension may take model files from another base URL (a local mirror; the
// worker hands the base out only when there is no update_url). The SHA-256 check in ensureFiles still
// applies, so this cannot load unverified bytes.
async function modelUrls(files) {
  const { devModelBase } = (await chrome.runtime.sendMessage({ type: "eng:dev-config" })) || {};
  if (!devModelBase) return files;
  return files.map((f) => ({ ...f, url: devModelBase + f.name }));
}

async function ensure(set, onProgress) {
  const files = await modelUrls(Object.values(set));
  return ensureFiles(files, { cache: await caches.open(MODEL_CACHE), onProgress });
}

// persist is false for the "" of a failed OCR: tabs learn the bubble is done, but a retry stays possible.
async function onText(pageId, bubbleId, text, persist) {
  if (persist) await store.setText(pageId, bubbleId, text);
  toWorker({ type: "eng:text", pageId, bubbleId, text });
}
const scheduler = new OcrScheduler((rgba, bubble) => engine.ocr(rgba, bubble), onText);

let manifestLoad = null;
function loadManifest() {
  manifestLoad ||= fetch(chrome.runtime.getURL("engine/models.manifest.json"))
    .then((r) => r.json())
    .catch((e) => {
      manifestLoad = null; // a failed read can be retried
      throw e;
    });
  return manifestLoad;
}

function boot() {
  booting ||= (async () => {
    engine = await retireEngine(engine); // a retry after a post-ready failure must not leak the old sessions
    prepared = preparing = null;
    setStatus({ state: "downloading", progress: 0 });
    try {
      store ||= await openStore(indexedDB);
      const manifest = await loadManifest();
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
      const started = await startEngine({
        ort,
        hasGpu: !!adapter,
        sets: buildModelSets(manifest),
        ensure,
        onStatus: setStatus,
        // The speed check lives in the worker's storage.local "benchmark" (its perfMode reads the mode there).
        savedBenchmark: {
          get: async () => (await chrome.runtime.sendMessage({ type: "eng:get-benchmark" }).catch(() => null))?.benchmark ?? null,
          set: (benchmark) => toWorker({ type: "eng:benchmark", benchmark }),
        },
      });
      engine = started.engine;
      preparing = started.settled.then((r) => {
        if (engine === started.engine && !r.error) prepared = r.benchmark;
        return prepared;
      });
    } catch (e) {
      console.error("engine start failed", e);
      setStatus({ state: "error", progress: 0, error: (e && e.error) || "engine_error" });
    }
  })().finally(() => {
    booting = null;
  });
  return booting;
}

async function toRgba(bitmap, crop) {
  const [sx, sy, w, h] = crop
    ? [Math.round(crop.x * crop.scale), Math.round(crop.y * crop.scale), Math.round(crop.width * crop.scale), Math.round(crop.height * crop.scale)]
    : [0, 0, bitmap.width, bitmap.height];
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return { rgba: { data, width: w, height: h }, canvas };
}

const fail = (error) => Object.assign(new Error(error), { code: error });

// Resolves {bytes, rgba}: the bytes identify the page (and are what we keep), rgba feeds the models.
async function readSource(source) {
  let blob;
  try {
    const resp = await fetch(source.url || source.dataUrl, source.url ? { credentials: "include" } : undefined);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    blob = await resp.blob();
  } catch {
    throw fail("fetch_failed");
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw fail("bad_image");
  }
  try {
    const { rgba, canvas } = await toRgba(bitmap, source.crop);
    const bytes = source.crop ? await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer() : await blob.arrayBuffer();
    return { bytes: new Uint8Array(bytes), rgba };
  } finally {
    bitmap.close();
  }
}

function remember(pageId, rgba) {
  decoded.delete(pageId);
  decoded.set(pageId, rgba);
  if (decoded.size > PAGES_IN_MEMORY) decoded.delete(decoded.keys().next().value);
}

// Decoded pixels of a page seen earlier (kept in memory, else decoded again from the stored image).
async function rgbaFor(pageId) {
  if (decoded.has(pageId)) return decoded.get(pageId);
  const bytes = await store.loadImage(pageId);
  if (!bytes) return null;
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const { rgba } = await toRgba(bitmap);
    remember(pageId, rgba);
    return rgba;
  } finally {
    bitmap.close();
  }
}


async function enginePage(msg) {
  if (status.state === "error") {
    const err = status.error;
    boot(); // every page request after a failure tries again
    if (err !== "models_cleared") return { ok: false, error: "engine_error" };
  }
  let busy = pageGate(status, prepared);
  if (busy && status.state === "ready" && preparing) {
    await waitPrepared(preparing, PREPARE_WAIT_MS); // a short wait saves the content script's retry delay
    if (status.state === "error") return { ok: false, error: "engine_error" };
    busy = pageGate(status, prepared);
  }
  if (busy) return busy;
  const { mode } = prepared;

  let img;
  try {
    img = await readSource(msg.source);
  } catch (e) {
    if (e.code) return { ok: false, error: e.code };
    throw e;
  }
  const { rgba, bytes } = img;
  if (Math.min(rgba.width, rgba.height) < MIN_SIDE || Math.max(rgba.width, rgba.height) < MIN_LONG_SIDE) {
    return { ok: false, error: "not_manga" };
  }
  const pageId = await store.pageIdFor(bytes);
  let page = await store.getPage(pageId);
  if (!page) {
    try {
      await store.savePage(pageId, rgba.width, rgba.height, await engine.detect(rgba));
    } catch (e) {
      console.error("detect failed", e);
      return { ok: false, error: "engine_error" };
    }
    page = await store.getPage(pageId);
  }
  if (!(await store.loadImage(pageId))) await store.saveImage(pageId, bytes);
  remember(pageId, rgba);
  if (resolveScope(msg.ocr, mode) === "all") scheduler.enqueuePage(pageId, rgba, page.bubbles);
  return { ok: true, page: { page_id: pageId, width: page.width, height: page.height, bubbles: page.bubbles } };
}

// The user hovers a bubble: OCR it next (also in on-demand mode, where nothing was queued). A text that is
// already known is returned in the reply instead of being OCR'd again.
async function enginePrioritize({ pageId, bubbleId }) {
  const busy = busyReply(status);
  if (busy) return busy;
  const page = await store.getPage(pageId);
  if (!page) return { ok: false, error: "page_expired" };
  const bubble = page.bubbles.find((b) => b.id === bubbleId);
  if (!bubble) return { ok: false, error: "unknown_bubble" };
  if (bubble.text != null) return { ok: true, text: bubble.text };
  const rgba = await rgbaFor(pageId);
  if (!rgba) return { ok: false, error: "page_expired" };
  scheduler.enqueuePage(pageId, rgba, [bubble]);
  scheduler.prioritize(pageId, bubbleId);
  return { ok: true };
}

// kuromoji loads its dictionary on first use; it does not depend on the OCR models. Its bundled path.join
// collapses the "//" of a chrome-extension:// URL, so the dictionary path is root-relative instead.
let tokenizerReady = null;
function tokenizer() {
  tokenizerReady ||= createTokenizer(globalThis.kuromoji, "/vendor/kuromoji/dict/").catch((e) => {
    tokenizerReady = null; // a failed load can be retried
    throw e;
  });
  return tokenizerReady;
}

// The page and bubble as stored; { error } when either is unknown.
async function findBubble({ pageId, bubbleId }) {
  store ||= await openStore(indexedDB);
  const bubble = (await store.getPage(pageId))?.bubbles.find((b) => b.id === bubbleId);
  return bubble ? { bubble } : { error: "unknown_bubble" };
}

// Text, furigana and tokens of a bubble whose text is known (works while the models are still downloading).
async function engineBubble({ pageId, bubbleId }) {
  store ||= await openStore(indexedDB);
  return bubbleReply(await store.getPage(pageId), bubbleId, tokenizer);
}

// JPEG (base64) of the panel around a bubble, for the Anki card.
async function engineCrop(msg) {
  const { bubble, error } = await findBubble(msg);
  if (error) return { ok: false, error };
  const rgba = await rgbaFor(msg.pageId);
  if (!rgba) return { ok: false, error: "page_expired" };
  return { ok: true, jpegBase64: await cropJpeg(rgba, findPanelBox(rgba, bubble.box)) };
}

// The dictionary is data in the same pinned, verified download path as the models, fetched on the first
// lookup (OCR start-up never waits for it) and dropped again after a few idle minutes: parsed it is ~200 MB.
const DICT_IDLE_MS = 3 * 60 * 1000;
let dict = null;
let dictLoad = null;
let dictIdle = null;

async function loadDict() {
  const file = buildModelSets(await loadManifest()).data.dict;
  if (!file) throw new Error("no dictionary in the manifest");
  const bytes = (await ensure({ dict: file })).get(file.name);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return Dictionary.fromJson(JSON.parse(await new Response(stream).text()));
}

function dropDict() {
  clearTimeout(dictIdle);
  dict = null;
}

async function engineLookup({ surface, lemma, reading }) {
  try {
    dictLoad ||= loadDict().finally(() => {
      dictLoad = null;
    });
    dict ||= await dictLoad;
  } catch (e) {
    console.error("dictionary load failed", e);
    return { ok: false, error: "dict_unavailable" };
  }
  clearTimeout(dictIdle);
  dictIdle = setTimeout(dropDict, DICT_IDLE_MS);
  const entries = dict.lookup({ surface, lemma, reading });
  const tags = {};
  for (const e of entries) for (const s of e.senses) for (const p of s.pos) if (dict.tags[p]) tags[p] = dict.tags[p];
  return { ok: true, entries, tags };
}

// The panel's Retry: the engine is started again after a failure (or after "delete models").
async function engineRetry() {
  if (status.state === "error") boot();
  return { ok: true };
}

async function engineClear() {
  store ||= await openStore(indexedDB);
  // Queued jobs are dropped and the running one is awaited and discarded before the engine goes away.
  scheduler.clear();
  await scheduler.idle();
  await engine?.dispose();
  engine = null;
  decoded.clear();
  await clearModels(await caches.open(MODEL_CACHE));
  await store.clear();
  dropDict();
  await toWorker({ type: "eng:benchmark", benchmark: null });
  setStatus({ state: "error", progress: 0, error: "models_cleared" });
  return { ok: true };
}

// The texts of a page that are already known (persisted), for a tab that starts watching it late.
async function engineTexts({ pageId }) {
  store ||= await openStore(indexedDB);
  const page = await store.getPage(pageId);
  const texts = page ? page.bubbles.filter((b) => b.text != null).map((b) => ({ bubbleId: b.id, text: b.text })) : [];
  return { ok: true, texts };
}

const common = {
  "eng:page": enginePage,
  "eng:prioritize": enginePrioritize,
  "eng:texts": engineTexts,
  "eng:bubble": engineBubble,
  "eng:crop": engineCrop,
  "eng:lookup": engineLookup,
  "eng:retry": engineRetry,
  "eng:status": async () => ({ ok: true, ...status }),
  "eng:clear": engineClear,
};
const probes = {
  "eng:probe-webgpu": probeWebgpu,
  "eng:probe-fetch": probeFetch,
  "eng:probe-anki": probeAnki,
};

// An offscreen document has no chrome.runtime.getManifest: read the extension's own manifest file. Any failure
// counts as the Store build (the stricter rules).
const devBuild = fetch(chrome.runtime.getURL("manifest.json"))
  .then((r) => r.json())
  .then(isDevBuild)
  .catch(() => false);

boot();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  const trust = { id: chrome.runtime.id, root: chrome.runtime.getURL("") };
  // Content scripts (a page URL) and other extensions never pass, in any build.
  if (!acceptSender(sender, { ...trust, dev: true })) return false;
  (async () => {
    const dev = await devBuild;
    // Store build: the service worker only. Unpacked: other pages of the extension too (the e2e harness).
    if (!acceptSender(sender, { ...trust, dev })) return { ok: false };
    const handler = engineHandlers(common, probes, dev)[msg.type];
    return handler ? handler(msg) : { ok: false, error: "unknown_message" };
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

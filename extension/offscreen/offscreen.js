// Offscreen engine host: runs the OCR models (onnxruntime-web) for the service worker.
// Messages from the SW carry target:"offscreen"; everything else is ignored.
import * as ort from "../vendor/ort/ort.webgpu.min.mjs";

ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
ort.env.wasm.numThreads = 1;

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

const handlers = {
  "eng:probe-webgpu": probeWebgpu,
  "eng:probe-fetch": probeFetch,
  "eng:probe-anki": probeAnki,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

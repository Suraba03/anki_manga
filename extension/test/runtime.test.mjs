import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chooseBackend, createEngine, configureOrt, runBenchmark } from "../engine/runtime.js";
import { makeBenchmarkPage } from "../engine/benchmark.js";

test("chooseBackend: working webgpu session -> webgpu", async () => {
  const tried = [];
  const ep = await chooseBackend({ hasGpu: true, createSession: async (e) => { tried.push(e); return {}; } });
  assert.equal(ep, "webgpu");
  assert.deepEqual(tried, ["webgpu"]);
});

test("chooseBackend: createSession throwing on webgpu -> wasm", async () => {
  const ep = await chooseBackend({
    hasGpu: true,
    createSession: async (e) => { if (e === "webgpu") throw new Error("no adapter"); return {}; },
  });
  assert.equal(ep, "wasm");
});

test("chooseBackend: no GPU -> wasm without trying webgpu", async () => {
  let calls = 0;
  const ep = await chooseBackend({ hasGpu: false, createSession: async () => { calls++; return {}; } });
  assert.equal(ep, "wasm");
  assert.equal(calls, 0);
});

test("chooseBackend: releases the probe session on success", async () => {
  let released = 0;
  const ep = await chooseBackend({ hasGpu: true, createSession: async () => ({ release: async () => { released++; } }) });
  assert.equal(ep, "webgpu");
  assert.equal(released, 1);
});

test("chooseBackend: configures ORT before probing when ort is given", async () => {
  const ort = { env: { wasm: {} } };
  let seen;
  await chooseBackend({ ort, hasGpu: true, createSession: async () => { seen = ort.env.wasm.numThreads; return {}; } });
  assert.ok(seen >= 1 && seen <= 4);
});

// Fake engine on an injected clock: detect/ocr advance the clock by a fixed amount.
const pickMode = (r) => ({ msPerPage: r.msPerPage, mode: r.mode });

function fakeEngine({ detectMs, ocrMs, bubbles = [{ box: [1, 2, 3, 4] }] }) {
  let t = 0;
  const calls = [];
  return {
    now: () => t,
    calls,
    engine: {
      ep: "wasm",
      detect: async () => { t += detectMs; return bubbles; },
      ocr: async (rgba, bubble) => { calls.push(bubble); t += ocrMs; return "x"; },
    },
  };
}

test("runBenchmark: detect 1000 ms + 12 x ocr 200 ms -> 3400, prefetch", async () => {
  const f = fakeEngine({ detectMs: 1000, ocrMs: 200 });
  const r = await runBenchmark(f.engine, { data: new Uint8ClampedArray(4), width: 1, height: 1 }, { now: f.now });
  assert.deepEqual(pickMode(r), { msPerPage: 3400, mode: "prefetch" });
  assert.equal(f.calls.length, 2); // one untimed warm-up OCR + one timed OCR
  assert.deepEqual(f.calls[0].box, [1, 2, 3, 4]);
});

test("runBenchmark: ocr 500 ms -> on-demand", async () => {
  const f = fakeEngine({ detectMs: 1000, ocrMs: 500 });
  const r = await runBenchmark(f.engine, makeBenchmarkPage(), { now: f.now });
  assert.deepEqual(pickMode(r), { msPerPage: 7000, mode: "on-demand" });
});

test("runBenchmark: exactly 6000 ms is on-demand", async () => {
  const f = fakeEngine({ detectMs: 0, ocrMs: 500 });
  const r = await runBenchmark(f.engine, makeBenchmarkPage(), { now: f.now });
  assert.deepEqual(pickMode(r), { msPerPage: 6000, mode: "on-demand" });
});

test("runBenchmark: no detected bubble -> OCR on a fixed box inside the page", async () => {
  const f = fakeEngine({ detectMs: 100, ocrMs: 10, bubbles: [] });
  const page = makeBenchmarkPage();
  const r = await runBenchmark(f.engine, page, { now: f.now });
  assert.deepEqual(pickMode(r), { msPerPage: 220, mode: "prefetch" });
  const [x1, y1, x2, y2] = f.calls[0].box;
  assert.ok(x1 >= 0 && y1 >= 0 && x2 <= page.width && y2 <= page.height && x2 > x1 && y2 > y1);
});

test("runBenchmark: an untimed warm-up (detect + ocr) runs first and is not counted", async () => {
  let t = 0, detects = 0;
  const calls = [];
  const engine = {
    detect: async () => { t += detects++ === 0 ? 5000 : 1000; return [{ box: [1, 2, 3, 4] }]; },
    ocr: async (rgba, bubble) => { calls.push(bubble); t += 200; return "x"; },
  };
  const r = await runBenchmark(engine, makeBenchmarkPage(), { now: () => t });
  assert.deepEqual(pickMode(r), { msPerPage: 3400, mode: "prefetch" });
  assert.equal(detects, 2);
  assert.equal(calls.length, 2);
});

test("makeBenchmarkPage: 1000x1400 RGBA, white with dark text-like regions", () => {
  const p = makeBenchmarkPage();
  assert.equal(p.width, 1000);
  assert.equal(p.height, 1400);
  assert.equal(p.data.length, 1000 * 1400 * 4);
  let white = 0, dark = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    if (p.data[i] === 255 && p.data[i + 1] === 255 && p.data[i + 2] === 255) white++;
    else if (p.data[i] < 40) dark++;
    assert.equal(p.data[i + 3], 255);
  }
  assert.ok(white > 0.7 * 1000 * 1400);
  assert.ok(dark > 1000);
});

test("configureOrt: threads capped at 4, wasmPaths only with chrome.runtime, for every backend", () => {
  const saved = { chrome: globalThis.chrome, nav: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  try {
    Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 16 }, configurable: true });
    delete globalThis.chrome;
    let ort = { env: { wasm: {} } };
    configureOrt(ort);
    assert.equal(ort.env.wasm.numThreads, 4);
    assert.equal(ort.env.wasm.wasmPaths, undefined);

    Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 2 }, configurable: true });
    globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://id/${p}` } };
    ort = { env: { wasm: {} } };
    configureOrt(ort);
    configureOrt(ort); // idempotent
    assert.equal(ort.env.wasm.numThreads, 2);
    assert.equal(ort.env.wasm.wasmPaths, "chrome-extension://id/vendor/ort/");
  } finally {
    if (saved.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = saved.chrome;
    if (saved.nav) Object.defineProperty(globalThis, "navigator", saved.nav);
  }
});

// A fake ORT that records session options and run inputs; tensors are plain {type,data,dims}.
function fakeOrt({ failOnByte } = {}) {
  const created = [];
  const released = [];
  const log = [];
  let active = 0, maxActive = 0;
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const ort = {
    env: { wasm: {} },
    Tensor,
    InferenceSession: {
      create: async (bytes, opts) => {
        const id = created.length;
        created.push({ bytes, opts });
        await new Promise((r) => setTimeout(r, 1));
        if (new Uint8Array(bytes)[0] === failOnByte) throw new Error("create failed");
        return {
          release: async () => { released.push(id); },
          run: async (feeds) => {
            active++; maxActive = Math.max(maxActive, active);
            log.push({ id, feeds });
            await new Promise((r) => setTimeout(r, 5));
            active--;
            if ("images" in feeds) {
              return {
                blk: new Tensor("float32", new Float32Array(0), [1, 0, 6]),
                seg: new Tensor("float32", new Float32Array(1024 * 1024), [1, 1, 1024, 1024]),
                det: new Tensor("float32", new Float32Array(2 * 1024 * 1024), [1, 2, 1024, 1024]),
              };
            }
            if ("pixel_values" in feeds) return { last_hidden_state: new Tensor("float32", new Float32Array(4), [1, 1, 4]) };
            // decoder: always end token (3) -> empty text
            const len = feeds.input_ids.dims[1];
            const logits = new Float32Array(len * 5);
            for (let i = 0; i < len; i++) logits[i * 5 + 3] = 1;
            return { logits: new Tensor("float32", logits, [1, len, 5]) };
          },
        };
      },
    },
  };
  return { ort, created, released, log, maxActive: () => maxActive };
}

const enc = (s) => new TextEncoder().encode(s).buffer;
const bytes = (n) => new Uint8Array([n]).buffer;

test("createEngine: sessions use the ep and graph optimisation, detect/ocr run through them", async () => {
  const f = fakeOrt();
  const files = { det: bytes(1), enc: bytes(2), dec: bytes(3), vocab: enc("[PAD]\n[UNK]\n[CLS]\n[SEP]\nあ") };
  const engine = await createEngine(f.ort, "wasm", files);
  assert.equal(engine.ep, "wasm");
  assert.equal(f.created.length, 3);
  for (const c of f.created) assert.deepEqual(c.opts.executionProviders, ["wasm"]);
  for (const c of f.created) assert.equal(c.opts.graphOptimizationLevel, "all");
  assert.deepEqual(f.created.map((c) => new Uint8Array(c.bytes)[0]), [1, 2, 3]);

  const page = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
  assert.deepEqual(await engine.detect(page), []);
  const text = await engine.ocr(page, { box: [0, 0, 32, 32] });
  assert.equal(text, "");
  const names = f.log.map((l) => Object.keys(l.feeds)[0]);
  assert.equal(names[0], "images");
  assert.equal(names[1], "pixel_values");
  assert.equal(names[2], "input_ids");
  assert.equal(f.log[2].feeds.input_ids.type, "int64");
  assert.ok("encoder_hidden_states" in f.log[2].feeds);
});

test("createEngine: concurrent calls are serialised", async () => {
  const f = fakeOrt();
  const engine = await createEngine(f.ort, "wasm", { det: bytes(1), enc: bytes(2), dec: bytes(3), vocab: enc("a\nb") });
  const page = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
  await Promise.all([
    engine.detect(page), engine.ocr(page, { box: [0, 0, 32, 32] }),
    engine.detect(page), engine.ocr(page, { box: [0, 0, 32, 32] }),
  ]);
  assert.equal(f.maxActive(), 1);
});

test("createEngine: a failing call does not block later calls", async () => {
  const f = fakeOrt();
  const engine = await createEngine(f.ort, "wasm", { det: bytes(1), enc: bytes(2), dec: bytes(3), vocab: enc("a") });
  const page = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
  await assert.rejects(engine.ocr(page, { box: [500, 500, 600, 600] })); // empty crop
  assert.equal(await engine.ocr(page, { box: [0, 0, 32, 32] }), "");
});

test("createEngine: with a trace log, each call records queued (jobs ahead), start and end", async () => {
  const f = fakeOrt();
  const engine = await createEngine(f.ort, "wasm", { det: bytes(1), enc: bytes(2), dec: bytes(3), vocab: enc("a\nb") });
  const page = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
  globalThis.__amTrace = [];
  try {
    await Promise.all([engine.detect(page), engine.detect(page), engine.ocr(page, { box: [0, 0, 32, 32] })]);
    const log = globalThis.__amTrace;
    const queued = log.filter((m) => m.name.endsWith(":queued"));
    assert.deepEqual(queued.map((m) => [m.name, m.ahead]), [["detect:queued", 0], ["detect:queued", 1], ["ocr:queued", 2]]);
    assert.deepEqual(log.filter((m) => m.name.endsWith(":start")).map((m) => m.name), ["detect:start", "detect:start", "ocr:start"]);
    assert.deepEqual(log.filter((m) => m.name.endsWith(":end")).map((m) => m.name), ["detect:end", "detect:end", "ocr:end"]);
    const [q0, q1] = queued;
    const [s0, s1] = log.filter((m) => m.name === "detect:start");
    const e0 = log.find((m) => m.name === "detect:end");
    assert.ok(s1.t >= e0.t, "the second detect starts after the first ends");
    assert.ok(s1.t - q1.t >= s0.t - q0.t, "and waited for it");
  } finally {
    delete globalThis.__amTrace;
  }
});

test("createEngine: a failing call still records its end and frees its place in the queue", async () => {
  const f = fakeOrt();
  const engine = await createEngine(f.ort, "wasm", { det: bytes(1), enc: bytes(2), dec: bytes(3), vocab: enc("a") });
  const page = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
  globalThis.__amTrace = [];
  try {
    await assert.rejects(engine.ocr(page, { box: [500, 500, 600, 600] }));
    await engine.detect(page);
    const log = globalThis.__amTrace;
    assert.ok(log.some((m) => m.name === "ocr:end"));
    assert.equal(log.find((m) => m.name === "detect:queued").ahead, 0);
  } finally {
    delete globalThis.__amTrace;
  }
});

test("createEngine: failed session creation releases the ones that succeeded and rejects", async () => {
  const f = fakeOrt({ failOnByte: 2 }); // encoder fails
  await assert.rejects(
    createEngine(f.ort, "webgpu", { det: bytes(1), enc: bytes(2), dec: bytes(3), vocab: enc("a") }),
    /create failed/,
  );
  assert.deepEqual([...f.released].sort(), [0, 2]);
});

test("createEngine: dispose releases all three sessions", async () => {
  const f = fakeOrt();
  const engine = await createEngine(f.ort, "wasm", { det: bytes(1), enc: bytes(2), dec: bytes(3), vocab: enc("a") });
  assert.deepEqual(f.released, []);
  await engine.dispose();
  assert.deepEqual([...f.released].sort(), [0, 1, 2]);
});

// Optional real-model check (wasm set, onnxruntime-node). Needs ANKI_MANGA_MODELS.
const modelDir = process.env.ANKI_MANGA_MODELS;
test("createEngine: real models detect + benchmark (wasm set)", { skip: !modelDir, timeout: 600000 }, async () => {
  const ort = await import("onnxruntime-node");
  const rd = (n) => { const b = readFileSync(join(modelDir, n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const engine = await createEngine(ort, "cpu", {
    det: rd("comic-text-detector.onnx"), enc: rd("encoder_model_q4.onnx"), dec: rd("decoder_model_q4.onnx"), vocab: rd("vocab.txt"),
  });
  const page = makeBenchmarkPage();
  assert.ok(Array.isArray(await engine.detect(page)));
  const r = await runBenchmark(engine, page);
  assert.equal(typeof r.msPerPage, "number");
  assert.ok(["prefetch", "on-demand"].includes(r.mode));
});

test("runBenchmark reports its parts: the untimed warm-up and the timed detect and OCR", async () => {
  const f = fakeEngine({ detectMs: 1000, ocrMs: 200 });
  const r = await runBenchmark(f.engine, makeBenchmarkPage(), { now: f.now });
  assert.deepEqual([r.warmupMs, r.detectMs, r.ocrMs], [1200, 1000, 200]);
});

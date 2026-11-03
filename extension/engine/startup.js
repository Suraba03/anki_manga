// Engine start-up sequence: ensure model files → choose backend → create engine (WebGPU, else WASM) → "ready".
// After ready, before the first real inference: warm up (the first inference compiles the shaders and proves the
// backend works; a WebGPU failure switches to WASM behind the same engine object), and measure the speed once per
// backend and model set (a saved result is reused while both are unchanged).
// Dependencies are injected so the sequence is testable in Node; the offscreen document wires the real ones.
import { chooseBackend as realChooseBackend, createEngine as realCreateEngine } from "./runtime.js";
import { makeBenchmarkPage, warmUp as realWarmUp, measure as realMeasure } from "./benchmark.js";
import { createEta } from "./progress.js";

const SLOTS = ["det", "enc", "dec", "vocab"];

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// What a saved benchmark result is valid for: the backend and the exact model files.
const benchmarkKey = (ep, set) => [ep, set.det.sha256, set.enc.sha256, set.dec.sha256].join("|");

// One line for the offscreen console, e.g. "engine ready in 2.1 s (webgpu), settled in 6.0 s: files_webgpu 0.3 s
// (network 0.0 MB), probe_webgpu 0.2 s, ..., warmup_webgpu 2.4 s, benchmark_webgpu 1.5 s"
function summaryLine(ep, timings) {
  const net = timings.files.filter((f) => f.source === "network").reduce((n, f) => n + f.bytes, 0);
  const stages = Object.entries(timings)
    .filter(([k]) => !["files", "total", "ready"].includes(k))
    .map(([k, ms]) => `${k} ${secs(ms)}${k.startsWith("files_") ? ` (network ${(net / 1e6).toFixed(1)} MB)` : ""}`);
  return `[anki-manga] engine ready in ${secs(timings.ready)} (${ep}), settled in ${secs(timings.total)}: ${stages.join(", ")}`;
}

// ensure(files, onProgress) → Map<name, ArrayBuffer> (verified bytes); onProgress(fraction, {receivedBytes,
// totalBytes, files}) as in ensureFiles. onStatus receives modelStatus-shaped objects: while downloading they carry
// receivedBytes/totalBytes/etaSec; "loading" carries firstRun (something was downloaded in this start); "ready"
// carries ep, mode (once known) and timings ({files_<set>, probe_webgpu, create_<ep>, ready, then warmup_<ep>,
// benchmark_<ep>, total} in ms, plus per-file records). "ready" is sent again when the background work settles.
// savedBenchmark: {get() → saved result | null, set(result)}: {msPerPage, mode, key} across starts.
// Resolves at ready: {engine, ep, benchmark: the reused saved result or null, settled}. engine is stable: its calls
// wait for the warm-up (and a needed measurement) and, after a WebGPU failure there, run on WASM. settled resolves (never rejects) to
// {ep, benchmark} or {error} once the background work is done. Model-file errors (ModelError) propagate untouched.
export async function startEngine({
  ort,
  hasGpu,
  sets,
  ensure,
  onStatus = () => {},
  chooseBackend = realChooseBackend,
  createEngine = realCreateEngine,
  warmUp = realWarmUp,
  measure = realMeasure,
  benchmarkPage = makeBenchmarkPage,
  savedBenchmark = { get: async () => null, set: async () => {} },
  now = () => performance.now(),
  log = (line) => console.info(line),
}) {
  const t0 = now();
  const timings = { files: [] };
  let firstRun = false;
  const timed = async (stage, fn) => {
    const t = now();
    try {
      return await fn();
    } finally {
      timings[stage] = now() - t;
    }
  };

  const load = (name, set) =>
    timed(`files_${name}`, async () => {
      const eta = createEta({ now });
      let files = [];
      const bytes = await ensure(set, (progress, info) => {
        if (!info) return onStatus({ state: "downloading", progress });
        files = info.files;
        if (info.totalBytes > 0) firstRun = true;
        onStatus({
          state: "downloading",
          progress,
          receivedBytes: info.receivedBytes,
          totalBytes: info.totalBytes,
          etaSec: info.totalBytes > 0 ? eta(info.receivedBytes, info.totalBytes) : null,
        });
      });
      timings.files.push(...files);
      return Object.fromEntries(SLOTS.map((slot) => [slot, bytes.get(set[slot].name)]));
    });
  const build = async (ep, files) => {
    onStatus({ state: "loading", progress: 1, ep, firstRun });
    return timed(`create_${ep}`, () => createEngine(ort, ep, files));
  };
  const buildWasm = async () => build("wasm", await load("wasm", sets.wasm));

  // Explicit undefined clears what a previous start left in the mirrored status.
  onStatus({ state: "downloading", progress: 0, receivedBytes: undefined, totalBytes: undefined, etaSec: undefined, firstRun: undefined, timings: undefined, mode: undefined });
  let current = null;
  let set = sets.wasm;
  if (hasGpu) {
    const files = await load("webgpu", sets.webgpu);
    const ep = await timed("probe_webgpu", () =>
      chooseBackend({
        ort,
        hasGpu,
        createSession: (provider) => ort.InferenceSession.create(files.det, { executionProviders: [provider] }),
      }),
    );
    if (ep === "webgpu") {
      try {
        current = await build("webgpu", files);
        set = sets.webgpu;
      } catch {
        // WebGPU accepted the probe but failed for the real models: continue on the CPU backend.
      }
    }
  }
  current ||= await buildWasm();

  const savedNow = await Promise.resolve()
    .then(() => savedBenchmark.get())
    .catch(() => null);
  const reusable = (ep, s) => (savedNow && savedNow.mode && savedNow.key === benchmarkKey(ep, s) ? savedNow : null);
  const initial = reusable(current.ep, set);
  timings.ready = now() - t0;
  const readyStatus = (mode) => ({ state: "ready", progress: 1, ep: current.ep, mode, timings: { ...timings, files: timings.files.slice() } });
  onStatus(readyStatus(initial?.mode));

  // Before real calls run: the warm-up (the compile cost they would pay anyway; a broken WebGPU is replaced before
  // they run), and, without a reusable saved result, the speed measurement (alone on the engine, so it times only
  // its own inferences). A WebGPU failure in either switches to WASM; a WASM failure is final.
  const page = benchmarkPage();
  const prepare = async () => {
    await timed(`warmup_${current.ep}`, () => warmUp(current, page));
    let benchmark = reusable(current.ep, set);
    if (!benchmark) {
      const m = await timed(`benchmark_${current.ep}`, () => measure(current, page));
      benchmark = { msPerPage: m.msPerPage, mode: m.mode, key: benchmarkKey(current.ep, set) };
      await Promise.resolve()
        .then(() => savedBenchmark.set(benchmark))
        .catch(() => {});
    }
    return benchmark;
  };
  const prepared = (async () => {
    try {
      return await prepare();
    } catch (e) {
      if (current.ep !== "webgpu") throw e;
      await current.dispose();
      current = await buildWasm();
      set = sets.wasm;
      return prepare();
    }
  })();
  const settled = prepared.then(
    (benchmark) => {
      timings.total = now() - t0;
      log(summaryLine(current.ep, timings));
      onStatus(readyStatus(benchmark.mode));
      return { ep: current.ep, benchmark };
    },
    (e) => {
      console.error("engine warm-up failed", e);
      onStatus({ state: "error", progress: 0, error: "engine_error" });
      return { error: "engine_error" };
    },
  );

  const after = (fn) => async (...args) => {
    await prepared;
    return fn(...args);
  };
  const engine = {
    get ep() {
      return current.ep;
    },
    detect: after((rgba) => current.detect(rgba)),
    ocr: after((rgba, bubble) => current.ocr(rgba, bubble)),
    dispose: async () => {
      await prepared.catch(() => {});
      return current.dispose();
    },
  };
  return { engine, ep: current.ep, benchmark: initial, settled };
}

// Engine start-up sequence: ensure model files → choose backend → create engine (WebGPU, else WASM) → benchmark once.
// Dependencies are injected so the sequence is testable in Node; the offscreen document wires the real ones.
import { chooseBackend as realChooseBackend, createEngine as realCreateEngine, runBenchmark as realRunBenchmark } from "./runtime.js";
import { makeBenchmarkPage } from "./benchmark.js";
import { createEta } from "./progress.js";

const SLOTS = ["det", "enc", "dec", "vocab"];

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// One line for the offscreen console: total, backend, then every stage, e.g.
// "engine ready in 41.2 s (webgpu): files_webgpu 30.1 s (network 336.7 MB), probe_webgpu 1.0 s, ..."
function summaryLine(ep, timings) {
  const net = timings.files.filter((f) => f.source === "network").reduce((n, f) => n + f.bytes, 0);
  const stages = Object.entries(timings)
    .filter(([k]) => k !== "files" && k !== "total")
    .map(([k, ms]) => `${k} ${secs(ms)}${k.startsWith("files_") ? ` (network ${(net / 1e6).toFixed(1)} MB)` : ""}`);
  return `[anki-manga] engine ready in ${secs(timings.total)} (${ep}): ${stages.join(", ")}`;
}

// ensure(files, onProgress) → Map<name, ArrayBuffer> (verified bytes); onProgress(fraction, {receivedBytes,
// totalBytes, files}) as in ensureFiles. onStatus receives modelStatus-shaped objects: while downloading they carry
// receivedBytes/totalBytes/etaSec; "loading" carries firstRun (something was downloaded in this start); "ready"
// carries timings ({files_<set>, probe_<set>, create_<ep>, benchmark_<ep>, total} in ms, plus per-file records).
// Resolves {engine, ep, benchmark:{msPerPage, mode}}. Model-file errors (ModelError) propagate untouched.
export async function startEngine({
  ort,
  hasGpu,
  sets,
  ensure,
  onStatus = () => {},
  chooseBackend = realChooseBackend,
  createEngine = realCreateEngine,
  runBenchmark = realRunBenchmark,
  benchmarkPage = makeBenchmarkPage,
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
  // Creates an engine on `ep` and runs the benchmark, whose detect() is the first real use of the sessions.
  const build = async (ep, files) => {
    onStatus({ state: "loading", progress: 1, ep, firstRun });
    const engine = await timed(`create_${ep}`, () => createEngine(ort, ep, files));
    try {
      return { engine, ep, benchmark: await timed(`benchmark_${ep}`, () => runBenchmark(engine, benchmarkPage())) };
    } catch (e) {
      await engine.dispose();
      throw e;
    }
  };
  const ready = (r) => {
    timings.total = now() - t0;
    log(summaryLine(r.ep, timings));
    onStatus({ state: "ready", progress: 1, ep: r.ep, mode: r.benchmark.mode, timings });
    return r;
  };

  // Explicit undefined clears what a previous start left in the mirrored status.
  onStatus({ state: "downloading", progress: 0, receivedBytes: undefined, totalBytes: undefined, etaSec: undefined, firstRun: undefined, timings: undefined });
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
        return ready(await build("webgpu", files));
      } catch {
        // WebGPU accepted the probe but failed for the real models: continue on the CPU backend.
      }
    }
  }
  return ready(await build("wasm", await load("wasm", sets.wasm)));
}

// Engine start-up sequence: ensure model files → choose backend → create engine (WebGPU, else WASM) → benchmark once.
// Dependencies are injected so the sequence is testable in Node; the offscreen document wires the real ones.
import { chooseBackend as realChooseBackend, createEngine as realCreateEngine, runBenchmark as realRunBenchmark } from "./runtime.js";
import { makeBenchmarkPage } from "./benchmark.js";

const SLOTS = ["det", "enc", "dec", "vocab"];

// ensure(files, onProgress) → Map<name, ArrayBuffer> (verified bytes). onStatus receives modelStatus-shaped objects.
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
}) {
  const load = async (set) => {
    const bytes = await ensure(set, (progress) => onStatus({ state: "downloading", progress }));
    return Object.fromEntries(SLOTS.map((slot) => [slot, bytes.get(set[slot].name)]));
  };
  // Creates an engine on `ep` and runs the benchmark, whose detect() is the first real use of the sessions.
  const build = async (ep, files) => {
    onStatus({ state: "loading", progress: 1, ep });
    const engine = await createEngine(ort, ep, files);
    try {
      return { engine, ep, benchmark: await runBenchmark(engine, benchmarkPage()) };
    } catch (e) {
      await engine.dispose();
      throw e;
    }
  };
  const ready = (r) => {
    onStatus({ state: "ready", progress: 1, ep: r.ep, mode: r.benchmark.mode });
    return r;
  };

  onStatus({ state: "downloading", progress: 0 });
  if (hasGpu) {
    const files = await load(sets.webgpu);
    const ep = await chooseBackend({
      ort,
      hasGpu,
      createSession: (provider) => ort.InferenceSession.create(files.det, { executionProviders: [provider] }),
    });
    if (ep === "webgpu") {
      try {
        return ready(await build("webgpu", files));
      } catch {
        // WebGPU accepted the probe but failed for the real models: continue on the CPU backend.
      }
    }
  }
  return ready(await build("wasm", await load(sets.wasm)));
}

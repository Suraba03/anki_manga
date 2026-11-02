// ORT session wiring: backend choice (WebGPU with WASM CPU fallback) and the engine object around detectPage/ocrBubble.
import { detectPage } from "./detector.js";
import { ocrBubble } from "./ocr.js";

export { runBenchmark } from "./benchmark.js";

// Tries a detector session on WebGPU; any failure (or no GPU) means the WASM CPU backend.
// createSession(ep) is supplied by the caller and builds a detector session for that ep; the probe is released.
// ort (optional): configured via configureOrt before probing.
export async function chooseBackend({ ort, hasGpu, createSession }) {
  if (ort) configureOrt(ort);
  if (!hasGpu) return "wasm";
  try {
    const probe = await createSession("webgpu");
    await probe?.release?.();
    return "webgpu";
  } catch {
    return "wasm";
  }
}

// Applies to every backend: the WebGPU build also loads its JSEP wasm through env.wasm.wasmPaths. Idempotent.
export function configureOrt(ort) {
  ort.env.wasm.numThreads = Math.min(4, globalThis.navigator?.hardwareConcurrency || 1);
    if (globalThis.chrome?.runtime?.getURL) ort.env.wasm.wasmPaths = globalThis.chrome.runtime.getURL("vendor/ort/");
}

// files: {det, enc, dec: ArrayBuffer (model bytes), vocab: ArrayBuffer (vocab.txt)}.
export async function createEngine(ort, ep, files) {
  configureOrt(ort);
  const opts = { executionProviders: [ep], graphOptimizationLevel: "all" };
  const results = await Promise.allSettled([
    ort.InferenceSession.create(files.det, opts),
    ort.InferenceSession.create(files.enc, opts),
    ort.InferenceSession.create(files.dec, opts),
  ]);
  const sessions = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const release = () => Promise.allSettled(sessions.map((s) => s.release?.()));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    await release(); // a retry on another backend must not leave sessions behind
    throw failed.reason;
  }
  const [det, enc, dec] = sessions;
  const vocab = new TextDecoder().decode(files.vocab).split("\n");

  const runModel = async (tensor) => {
    const out = await det.run({ images: new ort.Tensor("float32", tensor, [1, 3, 1024, 1024]) });
    return { blk: out.blk, seg: out.seg, det: out.det };
  };
  const runEncoder = async (pixels) =>
    (await enc.run({ pixel_values: new ort.Tensor("float32", pixels, [1, 3, 224, 224]) })).last_hidden_state;
  const runDecoder = async (ids, hidden) => {
    const out = await dec.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      encoder_hidden_states: hidden,
    });
    const { data, dims } = out.logits;
    const vocabSize = dims[2];
    return data.subarray((dims[1] - 1) * vocabSize, dims[1] * vocabSize);
  };

  // One inference at a time: ORT web sessions are not re-entrant on WebGPU.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };

  return {
    ep,
    dispose: release,
    detect: (rgba) => serial(() => detectPage(runModel, rgba)),
    ocr: (rgba, bubble) => serial(() => ocrBubble(runEncoder, runDecoder, vocab, rgba, bubble)),
  };
}

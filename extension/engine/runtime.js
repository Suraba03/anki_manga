// ORT session wiring: backend choice (WebGPU with WASM CPU fallback) and the engine object around detectPage/ocrBubble.
import { detectPage } from "./detector.js";
import { ocrBubble } from "./ocr.js";

export { runBenchmark } from "./benchmark.js";

// Tries a detector session on WebGPU; any failure (or no GPU) means the WASM CPU backend.
// createSession(ep) is supplied by the caller and builds a detector session for that ep.
export async function chooseBackend({ hasGpu, createSession }) {
  if (!hasGpu) return "wasm";
  try {
    await createSession("webgpu");
    return "webgpu";
  } catch {
    return "wasm";
  }
}

export function configureOrt(ort, ep) {
  if (ep !== "wasm") return;
  ort.env.wasm.numThreads = Math.min(4, globalThis.navigator?.hardwareConcurrency || 1);
    if (globalThis.chrome?.runtime?.getURL) ort.env.wasm.wasmPaths = globalThis.chrome.runtime.getURL("vendor/ort/");
}

// files: {det, enc, dec: ArrayBuffer (model bytes), vocab: ArrayBuffer (vocab.txt)}.
export async function createEngine(ort, ep, files) {
  configureOrt(ort, ep);
  const opts = { executionProviders: [ep], graphOptimizationLevel: "all" };
  const [det, enc, dec] = await Promise.all([
    ort.InferenceSession.create(files.det, opts),
    ort.InferenceSession.create(files.enc, opts),
    ort.InferenceSession.create(files.dec, opts),
  ]);
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
    detect: (rgba) => serial(() => detectPage(runModel, rgba)),
    ocr: (rgba, bubble) => serial(() => ocrBubble(runEncoder, runDecoder, vocab, rgba, bubble)),
  };
}

// Model acceptance: the in-browser pipeline (onnxruntime-node, CPU) must reproduce the v1 helper on real pages.
//   ANKI_MANGA_SAMPLES   folder with *.jpg pages and reference/*.json (tools/make-reference.py); unset = skipped
//   ANKI_MANGA_MODELS    folder with the model files (default: tools/.cache/models)
//   ANKI_MANGA_MODEL_SET "webgpu" = fp16 encoder + fp32 decoder instead of the q4 CPU set
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPage, yoloNms } from "../engine/detector.js";
import { linesFromMap } from "../engine/dbnet.js";
import { ocrBubble } from "../engine/ocr.js";
import { rgbaToDetInput } from "../engine/image.js";

const samples = process.env.ANKI_MANGA_SAMPLES;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modelDir = process.env.ANKI_MANGA_MODELS || join(root, "tools", ".cache", "models");
const webgpuSet = process.env.ANKI_MANGA_MODEL_SET === "webgpu";
const files = webgpuSet
  ? { enc: "encoder_model_fp16.onnx", dec: "decoder_model.onnx" }
  : { enc: "encoder_model_q4.onnx", dec: "decoder_model_q4.onnx" };

const iou = (a, b) => {
  const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const inter = iw > 0 && ih > 0 ? iw * ih : 0;
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
};
const quadBox = (q) => {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
// Greedy one-to-one matching by best IoU; returns the IoU of each reference box (0 when unmatched).
function matchIou(got, want) {
  const used = new Set();
  return want.map((w) => {
    let best = 0, bi = -1;
    got.forEach((g, i) => {
      if (used.has(i)) return;
      const v = iou(g, w);
      if (v > best) { best = v; bi = i; }
    });
    if (bi >= 0) used.add(bi);
    return best;
  });
}

async function loadEngine() {
  const ort = await import("onnxruntime-node");
  const opts = { executionProviders: ["cpu"], logSeverityLevel: 3 };
  const [det, enc, dec] = await Promise.all([
    ort.InferenceSession.create(join(modelDir, "comic-text-detector.onnx"), opts),
    ort.InferenceSession.create(join(modelDir, files.enc), opts),
    ort.InferenceSession.create(join(modelDir, files.dec), opts),
  ]);
  const vocab = readFileSync(join(modelDir, "vocab.txt"), "utf8").split("\n");
  return {
    vocab,
    runModel: async (tensor) => {
      const out = await det.run({ images: new ort.Tensor("float32", tensor, [1, 3, 1024, 1024]) });
      return { blk: out.blk, seg: out.seg, det: out.det };
    },
    runEncoder: async (pixels) => (await enc.run({ pixel_values: new ort.Tensor("float32", pixels, [1, 3, 224, 224]) })).last_hidden_state,
    runDecoder: async (ids, hidden) => {
      const out = await dec.run({
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
        encoder_hidden_states: hidden,
      });
      const { data, dims } = out.logits;
      const vocabSize = dims[2];
      return data.subarray((dims[1] - 1) * vocabSize, dims[1] * vocabSize);
    },
  };
}

const pages = samples && existsSync(join(samples, "reference"))
  ? readdirSync(join(samples, "reference")).filter((f) => f.endsWith(".json")).sort()
  : [];
let enginePromise;

test("models: reference JSON present for the sample pages", { skip: !samples }, () => {
  assert.ok(pages.length > 0, `no reference/*.json in ${samples}; run tools/make-reference.py first`);
});

for (const file of pages) {
  test(`models: ${file} matches the v1 helper`, { skip: !samples, timeout: 600000 }, async (t) => {
    const jpeg = (await import("jpeg-js")).default;
    const ref = JSON.parse(readFileSync(join(samples, "reference", file), "utf8"));
    const rgba = jpeg.decode(readFileSync(join(samples, file.replace(/\.json$/, ".jpg"))), { useTArray: true });
    assert.equal(rgba.width, ref.width);
    assert.equal(rgba.height, ref.height);
    enginePromise ??= loadEngine();
    const eng = await enginePromise;

    // Intermediates, so a divergence can be pinned to a stage.
    const t0 = Date.now();
    const { tensor, padW, padH } = rgbaToDetInput(rgba);
    const out = await eng.runModel(tensor);
    const rx = rgba.width / (1024 - padW), ry = rgba.height / (1024 - padH);

    const [, n, k] = out.blk.dims;
    const nms = yoloNms(out.blk.data, n, k).map((d) => [
      Math.trunc(d.box[0] * rx), Math.trunc(d.box[1] * ry), Math.trunc(d.box[2] * rx), Math.trunc(d.box[3] * ry),
    ]);
    assert.equal(nms.length, ref.nms.length, `NMS block count ${nms.length} vs ${ref.nms.length}`);
    const nmsIou = matchIou(nms, ref.nms.map((b) => b.box));
    assert.ok(nmsIou.every((v) => v >= 0.9), `NMS IoUs: ${nmsIou.map((v) => v.toFixed(3))}`);

    const lines = linesFromMap(out.det.data.subarray(0, 1024 * 1024), 1024, 1024)
      .filter((l) => l.score > 0.6)
      .map((l) => quadBox(l.box.map(([x, y]) => [Math.trunc(x * rx), Math.trunc(y * ry)])));
    assert.ok(Math.abs(lines.length - ref.lines.length) <= 2, `line count ${lines.length} vs ${ref.lines.length}`);
    const lineIou = matchIou(lines, ref.lines.map(quadBox));
    const goodLines = lineIou.filter((v) => v >= 0.8).length;
    assert.ok(goodLines >= 0.9 * ref.lines.length, `lines matched at IoU>=0.8: ${goodLines}/${ref.lines.length}`);

    // Full pipeline.
    const bubbles = await detectPage(eng.runModel, rgba);
    const t1 = Date.now();
    assert.equal(bubbles.length, ref.bubbles.length, `bubble count ${bubbles.length} vs ${ref.bubbles.length}`);

    // The browser decodes greedily, so faithfulness is judged against the PyTorch model decoded greedily
    // (text_greedy); the helper's beam-search text (num_beams 4, no_repeat_ngram_size 3) is informational only.
    let equal = 0, beamEqual = 0;
    const diffs = [], beamDiffs = [];
    for (let i = 0; i < bubbles.length; i++) {
      const text = await ocrBubble(eng.runEncoder, eng.runDecoder, eng.vocab, rgba, bubbles[i]);
      const nfkc = (v) => v.normalize("NFKC");
      const want = ref.bubbles[i].text_greedy;
      assert.equal(typeof want, "string", "reference lacks text_greedy; rerun tools/make-reference.py");
      if (nfkc(text) === nfkc(want)) equal++;
      else diffs.push(`  #${i} js=${JSON.stringify(text)} greedy=${JSON.stringify(want)}`);
      if (nfkc(text) === nfkc(ref.bubbles[i].text)) beamEqual++;
      else beamDiffs.push(`  #${i} js=${JSON.stringify(text)} helper-beam=${JSON.stringify(ref.bubbles[i].text)}`);
    }
    const t2 = Date.now();
    const pct = (100 * equal) / bubbles.length;
    t.diagnostic(
      `${file}: nms ${nms.length}/${ref.nms.length}, lines ${lines.length}/${ref.lines.length}, bubbles ${bubbles.length}/${ref.bubbles.length}, ` +
        `text vs greedy ${equal}/${bubbles.length} (${pct.toFixed(1)}%), vs helper beam ${beamEqual}/${bubbles.length} [${webgpuSet ? "webgpu set" : "cpu set"}], detect ${t1 - t0} ms, ocr ${t2 - t1} ms`,
    );
    if (beamDiffs.length) console.log(`texts differing from the helper's beam search in ${file} (informational):\n${beamDiffs.join("\n")}`);
    assert.ok(pct >= 90, `text equality vs greedy reference ${pct.toFixed(1)}% < 90%\n${diffs.join("\n")}`);
  });
}

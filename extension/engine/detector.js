// YOLO block-detector post-processing.
// Port of non_max_suppression (comic_text_detector/utils/yolov5_utils.py) as called by
// postprocess_yolo (inference.py): conf 0.4, IoU 0.35, best class only, class-aware, max 300.
// Rows are [cx, cy, w, h, obj, cls0..clsN-1] in letterbox pixels; sigmoid/decoding already done by the model head.
// Rescaling to image pixels (and the int32 truncation) is the caller's job (detectPage does it).

import { rgbaToDetInput } from "./image.js";
import { linesFromMap } from "./dbnet.js";
import { groupOutput } from "./textblocks.js";
import { mergeDuplicates, readingOrder } from "./boxes.js";

const MAX_WH = 4096;
const MAX_NMS = 30000;
const MAX_DET = 300;

export function yoloNms(blk, n, k, { conf = 0.4, iou = 0.35 } = {}) {
  const nc = k - 5;
  let cand = [];
  for (let i = 0; i < n; i++) {
    const o = blk[i * k + 4];
    if (!(o > conf)) continue;
    let best = -Infinity, cls = 0;
    for (let c = 0; c < nc; c++) {
      const v = Math.fround(blk[i * k + 5 + c] * o); // conf = obj_conf * cls_conf (float32)
      if (v > best) { best = v; cls = c; }
    }
    if (!(best > conf)) continue;
    const cx = blk[i * k], cy = blk[i * k + 1], w = blk[i * k + 2], h = blk[i * k + 3];
    cand.push({
      box: [Math.fround(cx - w / 2), Math.fround(cy - h / 2), Math.fround(cx + w / 2), Math.fround(cy + h / 2)],
      score: best,
      cls,
    });
  }
  if (cand.length > MAX_NMS) cand = cand.sort((a, b) => b.score - a.score).slice(0, MAX_NMS);

  // Batched NMS: boxes are offset by class so different classes never overlap.
  const off = cand.map((d) => d.box.map((v) => Math.fround(v + d.cls * MAX_WH)));
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  const order = cand.map((_, i) => i).sort((a, b) => cand[b].score - cand[a].score);
  const suppressed = new Uint8Array(cand.length);
  const keep = [];
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    if (suppressed[i]) continue;
    keep.push(i);
    if (keep.length >= MAX_DET) break;
    const a = off[i];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (suppressed[j]) continue;
      const b = off[j];
      const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      const inter = iw > 0 && ih > 0 ? iw * ih : 0;
      if (inter / (area(a) + area(b) - inter) > iou) suppressed[j] = 1;
    }
  }
  return keep.map((i) => cand[i]);
}

// Python slice.indices(n) for a numpy slice a:b (negative wraps, out of range clamps).
function sliceRange(a, b, n) {
  const norm = (v) => (v < 0 ? Math.max(v + n, 0) : Math.min(v, n));
  return [norm(a), norm(b)];
}

// Mean of the text mask over [x1,x2) x [y1,y2) in image pixels, 0..1, with numpy semantics of
// mask[y1:y2, x1:x2].mean() / 255 (NaN for an empty slice). Python resizes the cropped uint8 mask to the image
// size with cv2 INTER_LINEAR first; this samples the same bilinear mapping (half-pixel centres, edge clamp, uint8
// rounding) per requested pixel instead of materialising the full-size mask.
function makeMaskMean(seg, size, padW, padH, imW, imH) {
  const cw = size - padW, ch = size - padH;
  const mask = new Uint8Array(cw * ch); // postprocess_mask: *255, astype(uint8)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) mask[y * cw + x] = Math.trunc(seg[y * size + x] * 255);
  const sx = cw / imW, sy = ch / imH;
  return (x1, y1, x2, y2) => {
    const [xa, xb] = sliceRange(x1, x2, imW);
    const [ya, yb] = sliceRange(y1, y2, imH);
    if (xa >= xb || ya >= yb) return NaN;
    let sum = 0;
    for (let y = ya; y < yb; y++) {
      let fy = (y + 0.5) * sy - 0.5, y0 = Math.floor(fy);
      fy -= y0;
      if (y0 < 0) { y0 = 0; fy = 0; }
      if (y0 >= ch - 1) { y0 = ch - 1; fy = 0; }
      const y1i = Math.min(y0 + 1, ch - 1);
      for (let x = xa; x < xb; x++) {
        let fx = (x + 0.5) * sx - 0.5, x0 = Math.floor(fx);
        fx -= x0;
        if (x0 < 0) { x0 = 0; fx = 0; }
        if (x0 >= cw - 1) { x0 = cw - 1; fx = 0; }
        const x1i = Math.min(x0 + 1, cw - 1);
        const top = mask[y0 * cw + x0] * (1 - fx) + mask[y0 * cw + x1i] * fx;
        const bot = mask[y1i * cw + x0] * (1 - fx) + mask[y1i * cw + x1i] * fx;
        sum += Math.floor(top * (1 - fy) + bot * fy + 0.5);
      }
    }
    return sum / ((xb - xa) * (yb - ya)) / 255;
  };
}

// Whole detect pipeline, port of TextDetector.__call__ + the helper's Engine.detect.
// runModel(tensor: Float32Array[1x3x1024x1024]) -> Promise<{blk, seg, det}>, each an ort-style {data, dims}:
//   blk [1, N, 5 + classes] YOLO rows, seg [1, 1, 1024, 1024] text mask, det [1, 2, 1024, 1024] DBNet maps.
// rgba: {data, width, height}. Returns bubbles {id, box, vertical, font_size, lines} in reading order (no text yet).
export async function detectPage(runModel, rgba) {
  const size = 1024;
  const { width: imW, height: imH } = rgba;
  const { tensor, padW, padH } = rgbaToDetInput(rgba, size);
  const { blk, seg, det } = await runModel(tensor);
  const rx = imW / (size - padW), ry = imH / (size - padH); // resize_ratio, as Python (not 1 / scale)

  // postprocess_yolo: float32 boxes * ratio, truncated to int32.
  const fx = Math.fround(rx), fy = Math.fround(ry);
  const [, n, k] = blk.dims;
  const blocks = yoloNms(blk.data, n, k).map(({ box, cls }) => ({
    box: [
      Math.trunc(Math.fround(box[0] * fx)), Math.trunc(Math.fround(box[1] * fy)),
      Math.trunc(Math.fround(box[2] * fx)), Math.trunc(Math.fround(box[3] * fy)),
    ],
    cls,
  }));

  // DBNet lines (det channel 0, box_thresh 0.6 inside linesFromMap), float64 * ratio, truncated to int32.
  const lines = linesFromMap(det.data.subarray(0, size * size), size, size).map((l) =>
    l.box.map(([x, y]) => [Math.trunc(x * rx), Math.trunc(y * ry)]));

  const maskMean = makeMaskMean(seg.data, size, padW, padH, imW, imH);
  const groups = groupOutput(blocks, lines, imW, imH, maskMean);
  const bubbles = groups.map((g, i) => ({
    id: i,
    box: g.xyxy.map(Number),
    vertical: Boolean(g.vertical),
    font_size: Number(g.fontSize),
    lines: g.lines.map((q) => q.map(([x, y]) => [Number(x), Number(y)])),
  }));
  return readingOrder(mergeDuplicates(bubbles), imW);
}

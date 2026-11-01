// YOLO block-detector post-processing.
// Port of non_max_suppression (comic_text_detector/utils/yolov5_utils.py) as called by
// postprocess_yolo (inference.py): conf 0.4, IoU 0.35, best class only, class-aware, max 300.
// Rows are [cx, cy, w, h, obj, cls0..clsN-1] in letterbox pixels; sigmoid/decoding already done by the model head.
// Rescaling to image pixels (and the int32 truncation) is the caller's job.

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

// DBNet probability map -> text line boxes.
// Port of SegDetectorRepresenter.boxes_from_bitmap (comic_text_detector/utils/db_utils.py).
import { convexHull, minAreaRect, boxPoints, orderBox, polygonArea, polygonPerimeter } from "./geometry.js";

// Mean of prob inside the convex polygon (scanline fill, bbox-clipped like box_score_fast).
function polygonMean(prob, w, h, poly) {
  let ymin = Infinity, ymax = -Infinity;
  for (const p of poly) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
  const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(h - 1, Math.ceil(ymax));
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      if (Math.abs(ay - by) < 1e-9) {
        if (Math.abs(ay - y) < 1e-9) { lo = Math.min(lo, ax, bx); hi = Math.max(hi, ax, bx); }
        continue;
      }
      if (y < Math.min(ay, by) - 1e-9 || y > Math.max(ay, by) + 1e-9) continue;
      const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (lo > hi) continue;
    const xa = Math.max(0, Math.ceil(lo - 1e-9)), xb = Math.min(w - 1, Math.floor(hi + 1e-9));
    for (let x = xa; x <= xb; x++) { sum += prob[y * w + x]; n++; }
  }
  return n ? sum / n : 0;
}

export function linesFromMap(prob, w, h, opts = {}) {
  const { thresh = 0.3, boxThresh = 0.6, unclipRatio = 1.5, maxCandidates = 1000 } = opts;
  const total = w * h;
  const bin = new Uint8Array(total);
  for (let i = 0; i < total; i++) bin[i] = prob[i] > thresh ? 1 : 0;

  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const out = [];
  let candidates = 0;

  for (let start = 0; start < total && candidates < maxCandidates; start++) {
    if (!bin[start] || seen[start]) continue;
    candidates++;
    // Iterative 8-connected flood fill; keep boundary pixels only (hull extremes are boundary pixels).
    const boundary = [];
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      let edge = false;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) { edge = true; continue; }
          const j = ny * w + nx;
          if (!bin[j]) { edge = true; continue; }
          if (!seen[j]) { seen[j] = 1; stack[sp++] = j; }
        }
      }
      if (edge) boundary.push([x, y]);
    }

    const hull = convexHull(boundary);
    const rect = minAreaRect(hull);
    if (Math.min(rect.size[0], rect.size[1]) < 2) continue;
    const score = polygonMean(prob, w, h, hull);
    if (!(score > boxThresh)) continue;

    // Unclip: round-joined offset of a rectangle has the rect grown by d on every side as min-area rect.
    const quad = orderBox(boxPoints(rect));
    const d = (polygonArea(quad) * unclipRatio) / polygonPerimeter(quad);
    const grown = orderBox(boxPoints({
      center: rect.center,
      size: [rect.size[0] + 2 * d, rect.size[1] + 2 * d],
      angle: rect.angle,
    }));
    const box = grown.map(([x, y]) => [
      Math.min(Math.max(Math.round(x), 0), w),
      Math.min(Math.max(Math.round(y), 0), h),
    ]);
    out.push({ box, score });
  }
  return out;
}

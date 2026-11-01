// DBNet probability map -> text line boxes.
// Port of SegDetectorRepresenter.boxes_from_bitmap (comic_text_detector/utils/db_utils.py).
// Score = mean prob over the component's own pixels (what box_score_fast gets by filling the traced contour).
import { convexHull, minAreaRect, boxPoints, orderBox, polygonArea, polygonPerimeter } from "./geometry.js";

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
    let sum = 0, count = 0;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      sum += prob[i];
      count++;
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
    const score = sum / count;
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

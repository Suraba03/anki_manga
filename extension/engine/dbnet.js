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

    // Unclip like Python: Polygon area/perimeter of the float min-area quad give the distance, then pyclipper
    // offsets the quad truncated to integers (round joins), and the result's min-area rect is the box.
    const quad = boxPoints(rect).map(([x, y]) => [Math.fround(x), Math.fround(y)]); // cv2 hands over float32
    const d = (polygonArea(quad) * unclipRatio) / polygonPerimeter(quad);
    const grown = orderBox(boxPoints(minAreaRect(offsetRound(quad.map(([x, y]) => [Math.trunc(x), Math.trunc(y)]), d))));
    const box = grown.map(([x, y]) => [
      Math.min(Math.max(Math.round(x), 0), w),
      Math.min(Math.max(Math.round(y), 0), h),
    ]);
    out.push({ box, score });
  }
  return out;
}

// Clipper (ClipperOffset, JT_ROUND, ArcTolerance 0.25) outline of a convex polygon grown by delta: unit edge
// normals, every vertex rounded to an integer, round joins as arcs of equal angular steps.
function offsetRound(poly, delta) {
  const n = poly.length;
  const cx = poly.reduce((a, p) => a + p[0], 0) / n, cy = poly.reduce((a, p) => a + p[1], 0) / n;
  const normal = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return [0, 0];
    const f = 1 / Math.sqrt(dx * dx + dy * dy);
    return [dy * f, -dx * f];
  };
  const rnd = (v) => (v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5)); // Clipper Round()
  // Clipper wants the outer path positively oriented; pick the direction whose normals point outwards.
  const mid = [(poly[0][0] + poly[1][0]) / 2 - cx, (poly[0][1] + poly[1][1]) / 2 - cy];
  const n0 = normal(poly[0], poly[1]);
  const path = n0[0] * mid[0] + n0[1] * mid[1] >= 0 ? poly : [...poly].reverse();
  const normals = path.map((p, i) => normal(p, path[(i + 1) % n]));

  let steps = Math.PI / Math.acos(1 - 0.25 / Math.abs(delta));
  if (steps > Math.abs(delta) * Math.PI) steps = Math.abs(delta) * Math.PI;
  const sin = Math.sin((2 * Math.PI) / steps), cos = Math.cos((2 * Math.PI) / steps);
  const stepsPerRad = steps / (2 * Math.PI);

  const out = [];
  let k = n - 1;
  for (let j = 0; j < n; j++) {
    const nj = normals[j], nk = normals[k];
    const sinA = Math.max(-1, Math.min(1, nk[0] * nj[1] - nj[0] * nk[1]));
    const cosA = nk[0] * nj[0] + nk[1] * nj[1];
    const pt = path[j];
    if (Math.abs(sinA * delta) < 1 && cosA > 0) {
      out.push([rnd(pt[0] + nk[0] * delta), rnd(pt[1] + nk[1] * delta)]);
    } else if (sinA * delta < 0) {
      out.push([rnd(pt[0] + nk[0] * delta), rnd(pt[1] + nk[1] * delta)], [pt[0], pt[1]],
        [rnd(pt[0] + nj[0] * delta), rnd(pt[1] + nj[1] * delta)]);
    } else {
      const m = Math.max(rnd(stepsPerRad * Math.abs(Math.atan2(sinA, cosA))), 1);
      let x = nk[0], y = nk[1];
      for (let i = 0; i < m; i++) {
        out.push([rnd(pt[0] + x * delta), rnd(pt[1] + y * delta)]);
        const x2 = x;
        x = x * cos - sin * y;
        y = x2 * sin + y * cos;
      }
      out.push([rnd(pt[0] + nj[0] * delta), rnd(pt[1] + nj[1] * delta)]);
    }
    k = j;
  }
  return out;
}

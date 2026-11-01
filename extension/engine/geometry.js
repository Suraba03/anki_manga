// Pure 2D geometry helpers (ports of the OpenCV calls used by comic_text_detector).
// Points are [x, y] arrays.

const EPS = 1e-9;

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function polygonPerimeter(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += Math.hypot(x2 - x1, y2 - y1);
  }
  return s;
}

// Andrew's monotone chain. Returns the hull without collinear points.
export function convexHull(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  if (uniq.length <= 2) return uniq;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (seq) => {
    const out = [];
    for (const p of seq) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return build(uniq).concat(build([...uniq].reverse()));
}

// Minimum-area bounding rectangle (rotating calipers over hull edges).
// size[0] is measured along `angle` (degrees), size[1] along its normal.
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 0) return { center: [0, 0], size: [0, 0], angle: 0 };
  if (hull.length === 1) return { center: [hull[0][0], hull[0][1]], size: [0, 0], angle: 0 };
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < EPS) continue;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy, v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU, h = maxV - minV, area = w * h;
    if (best === null || area < best.area - EPS) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = {
        area,
        center: [cu * ux - cv * uy, cu * uy + cv * ux],
        size: [w, h],
        angle: (Math.atan2(uy, ux) * 180) / Math.PI,
      };
    }
  }
  return { center: best.center, size: best.size, angle: best.angle };
}

// Same corner layout as cv2.boxPoints.
export function boxPoints({ center, size, angle }) {
  const rad = (angle * Math.PI) / 180;
  const b = Math.cos(rad) * 0.5, a = Math.sin(rad) * 0.5;
  const [cx, cy] = center, [w, h] = size;
  const p0 = [cx - a * h - b * w, cy + b * h - a * w];
  const p1 = [cx + a * h - b * w, cy - b * h - a * w];
  return [p0, p1, [2 * cx - p0[0], 2 * cy - p0[1]], [2 * cx - p1[0], 2 * cy - p1[1]]];
}

// Ordering of get_mini_boxes: top-left, top-right, bottom-right, bottom-left.
export function orderBox(points4) {
  const p = [...points4].sort((a, b) => a[0] - b[0]);
  const [i1, i4] = p[1][1] > p[0][1] ? [0, 1] : [1, 0];
  const [i2, i3] = p[3][1] > p[2][1] ? [2, 3] : [3, 2];
  return [p[i1], p[i2], p[i3], p[i4]].map((q) => [q[0], q[1]]);
}

// Separating-axis test for convex polygons. Touching counts as intersecting.
export function quadsIntersect(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y1 - y2, ny = x2 - x1;
      if (Math.abs(nx) < EPS && Math.abs(ny) < EPS) continue;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const [x, y] of b) { const d = x * nx + y * ny; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      const tol = EPS * Math.hypot(nx, ny) * 1e3;
      if (maxA < minB - tol || maxB < minA - tol) return false;
    }
  }
  return true;
}

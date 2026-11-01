// Text line -> text block grouping.
// Port of comic_text_detector/utils/textblock.py (TextBlock, examine_textblk, split_textblk,
// try_merge_textline, merge_textlines, sort_textblk_list, group_output). Behaviour follows the
// Python source, quirks included. shapely Polygon.intersects -> quadsIntersect.
// Skipped as dead for our path: font/stroke colours, transformed regions, min_rect/aspect_ratio,
// alignment, text/translation fields, visualisation.
import { quadsIntersect } from "./geometry.js";

export const LANG_LIST = ["eng", "ja", "unknown"];
const BBOX_SCORE_THRESH = 0.4;
const MASK_SCORE_THRESH = 0.1;

const hypot = (x, y) => Math.sqrt(x * x + y * y); // numpy norm, not Math.hypot
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Python round(): half to even.
function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// Key comparator with Python semantics (NaN compares equal to everything).
const byKey = (key) => (a, b) => {
  const ka = key(a), kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

function makeBlock(xyxy, lines = [], language = "unknown") {
  return {
    xyxy: xyxy.map(Math.trunc),
    lines,
    language,
    vertical: false,
    fontSize: -1,
    distance: null,
    angle: 0,
    vec: null,
    norm: -1,
    merged: false,
    weight: -1,
  };
}

function cloneBlock(blk) {
  return {
    ...blk,
    xyxy: [...blk.xyxy],
    lines: blk.lines.map((l) => l.map((p) => [...p])),
    distance: blk.distance && [...blk.distance],
    vec: blk.vec && [...blk.vec],
  };
}

function unionArea(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  if (y2 < y1 || x2 < x1) return -1;
  return (y2 - y1) * (x2 - x1);
}

function adjustBbox(blk, withBbox) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const l of blk.lines) {
    for (const [x, y] of l) {
      x1 = Math.min(x1, Math.trunc(x)); x2 = Math.max(x2, Math.trunc(x));
      y1 = Math.min(y1, Math.trunc(y)); y2 = Math.max(y2, Math.trunc(y));
    }
  }
  blk.xyxy = withBbox
    ? [Math.min(x1, blk.xyxy[0]), Math.min(y1, blk.xyxy[1]), Math.max(x2, blk.xyxy[2]), Math.max(y2, blk.xyxy[3])]
    : [x1, y1, x2, y2];
}

// np.argsort with NaN last.
function argsort(values) {
  const nanLast = (v) => (Number.isNaN(v) ? Infinity : v);
  return values.map((_, i) => i).sort((a, b) => {
    const na = Number.isNaN(values[a]), nb = Number.isNaN(values[b]);
    if (na || nb) return na === nb ? 0 : na ? 1 : -1;
    return nanLast(values[a]) - nanLast(values[b]);
  });
}

function sortLines(blk) {
  if (!blk.distance) return;
  const idx = argsort(blk.distance);
  blk.distance = idx.map((i) => blk.distance[i]);
  blk.lines = idx.map((i) => blk.lines[i]);
}

export function sortTextblkList(blkList, imW, imH) {
  if (blkList.length === 0) return blkList;
  const numJa = blkList.filter((b) => b.language === "ja").length;
  const flipLr = numJa > blkList.length / 2;
  const imOriW = imW;
  if (imW > imH) imW /= 2;
  const numGridY = 4, numGridX = 3;
  const imgArea = imH * imW;
  for (const blk of blkList) {
    let centerX = (blk.xyxy[0] + blk.xyxy[2]) / 2;
    if (flipLr) centerX = imW !== imOriW ? imOriW - centerX : imW - centerX;
    const gridX = Math.trunc((centerX / imW) * numGridX);
    const centerY = (blk.xyxy[1] + blk.xyxy[3]) / 2;
    const gridY = Math.trunc((centerY / imH) * numGridY);
    const gridIndex = gridY * numGridX + gridX;
    let weight = gridIndex * imgArea + 1.2 * (centerX - (gridX * imW) / numGridX) + (centerY - (gridY * imH) / numGridY);
    if (imW !== imOriW && gridX >= numGridX) weight += imgArea * numGridY * numGridX;
    blk.weight = weight;
  }
  return blkList.sort(byKey((b) => b.weight));
}

export function examineTextblk(blk, imW, imH, sort = false) {
  const lines = blk.lines;
  let vx = 0, vy = 0, hx = 0, hy = 0;
  const centers = [];
  lines.forEach((l, i) => {
    const m = (j) => [(l[(j + 1) % 4][0] + l[j][0]) / 2, (l[(j + 1) % 4][1] + l[j][1]) / 2];
    const [m0, m1, m2, m3] = [m(0), m(1), m(2), m(3)];
    if (i === 0) { vx = m2[0] - m0[0]; vy = m2[1] - m0[1]; hx = m1[0] - m3[0]; hy = m1[1] - m3[1]; }
    else { vx += m2[0] - m0[0]; vy += m2[1] - m0[1]; hx += m1[0] - m3[0]; hy += m1[1] - m3[1]; }
    centers.push([(l[0][0] + l[2][0]) / 2, (l[0][1] + l[2][1]) / 2]);
  });
  const normV = hypot(vx, vy), normH = hypot(hx, hy);
  const vertical = blk.language === "ja" ? normV > normH : normV > normH * 2;
  let primary, primaryNorm, origin, fontSize;
  if (vertical) {
    primary = [vx, vy]; primaryNorm = normV;
    origin = [imW, 0]; // vertical manga text is read right to left
    fontSize = roundHalfEven(normH / lines.length);
  } else {
    primary = [hx, hy]; primaryNorm = normH;
    origin = [0, 0];
    fontSize = roundHalfEven(normV / lines.length);
  }
  let angle = Math.trunc((Math.atan2(primary[1], primary[0]) / Math.PI) * 180);
  const distance = centers.map(([cx, cy]) => {
    const dx = cx - origin[0], dy = cy - origin[1];
    const d = hypot(dx, dy);
    const rad = Math.acos((dx * primary[0] + dy * primary[1]) / (d * primaryNorm));
    return Math.abs(Math.sin(rad) * d);
  });
  blk.lines = lines.map((l) => l.map((p) => [Math.trunc(p[0]), Math.trunc(p[1])]));
  blk.distance = distance;
  if (vertical) angle -= 90;
  if (Math.abs(angle) < 3) angle = 0;
  blk.angle = angle;
  blk.fontSize = fontSize;
  blk.vertical = vertical;
  blk.vec = primary;
  blk.norm = primaryNorm;
  if (sort) sortLines(blk);
}

function tryMergeTextline(blk, blk2, fntsizeTol = 1.3, distanceTol = 2) {
  if (blk2.merged) return false;
  const fntsizeDiv = blk.fontSize / blk2.fontSize;
  const numL1 = blk.lines.length, numL2 = blk2.lines.length;
  const fntszAvg = (blk.fontSize * numL1 + blk2.fontSize * numL2) / (numL1 + numL2);
  const vecProd = blk.vec[0] * blk2.vec[0] + blk.vec[1] * blk2.vec[1];
  const vecSum = [blk.vec[0] + blk2.vec[0], blk.vec[1] + blk2.vec[1]];
  const cosVec = vecProd / blk.norm / blk2.norm;
  const distance = blk2.distance[blk2.distance.length - 1] - blk.distance[blk.distance.length - 1];
  const last1 = blk.lines[blk.lines.length - 1], last2 = blk2.lines[blk2.lines.length - 1];
  const distanceP1 = hypot(last2[0][0] - last1[0][0], last2[0][1] - last1[0][1]);
  if (!quadsIntersect(last1, last2)) {
    if (fntsizeDiv > fntsizeTol || 1 / fntsizeDiv > fntsizeTol) return false;
    if (Math.abs(cosVec) < 0.866) return false; // cos 30
    if (distance > distanceTol * fntszAvg || distanceP1 > fntszAvg * 2.5) return false;
  }
  blk.lines.push(blk2.lines[0]);
  blk.vec = vecSum;
  let angle = roundHalfEven(Math.atan2(vecSum[1], vecSum[0]) * RAD2DEG);
  if (blk.vertical) angle -= 90;
  blk.angle = angle;
  blk.norm = hypot(vecSum[0], vecSum[1]);
  blk.distance = [...blk.distance, blk2.distance[blk2.distance.length - 1]];
  blk.fontSize = fntszAvg;
  blk2.merged = true;
  return true;
}

function mergeTextlines(blkList) {
  if (blkList.length < 2) return blkList;
  blkList.sort(byKey((b) => b.distance[0]));
  const merged = [];
  blkList.forEach((cur, ii) => {
    if (cur.merged) return;
    for (let jj = ii + 1; jj < blkList.length; jj++) tryMergeTextline(cur, blkList[jj]);
    merged.push(cur);
  });
  for (const blk of merged) adjustBbox(blk, false);
  return merged;
}

function splitTextblk(blk) {
  const { fontSize, distance } = blk;
  const lines = blk.lines;
  const l0 = lines[0];
  lines.sort(byKey((l) => hypot(l[0][0] - l0[0][0], l[0][1] - l0[0][1]))); // distance array is NOT reordered (as in Python)
  const distanceTol = fontSize * 2;
  let current = cloneBlock(blk);
  current.lines = [l0];
  const subs = [current];
  for (let jj = 0; jj < lines.length - 1; jj++) {
    const line = lines[jj + 1];
    let split = false;
    if (!quadsIntersect(lines[jj], line)) {
      const lineDistance = Math.abs(distance[jj + 1] - distance[jj]);
      if (lineDistance > distanceTol) {
        split = true;
      } else if (blk.vertical && Math.abs(blk.angle) < 15) {
        if (current.lines.length > 1 || lineDistance > fontSize) {
          split = Math.abs(lines[jj][0][1] - line[0][1]) > fontSize;
        }
      }
    }
    if (split) {
      current = cloneBlock(current);
      current.lines = [line];
      subs.push(current);
    } else {
      current.lines.push(line);
    }
  }
  if (subs.length > 1) {
    for (const b of subs) adjustBbox(b, false);
    return [true, subs];
  }
  return [false, subs];
}

// blocks: [{box: [x1,y1,x2,y2], cls}], lines: [x,y][4][] (integer pixels), maskMean(x1,y1,x2,y2) -> 0..1 or null.
export function groupOutput(blocks, lines, imW, imH, maskMean = null, sortBlklist = true) {
  const blkList = blocks.map((b) => makeBlock(b.box, [], LANG_LIST[b.cls] ?? "unknown"));
  const scattered = { ver: [], hor: [] };

  // step 1: filter & assign lines to text blocks
  for (const raw of lines) {
    const line = raw.map((p) => [Math.trunc(p[0]), Math.trunc(p[1])]);
    const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
    const bx1 = Math.min(...xs), bx2 = Math.max(...xs), by1 = Math.min(...ys), by2 = Math.max(...ys);
    let bboxScore = -1, bboxIdx = -1;
    const lineArea = (by2 - by1) * (bx2 - bx1);
    blkList.forEach((blk, jj) => {
      const score = unionArea(blk.xyxy, [bx1, by1, bx2, by2]) / lineArea;
      if (bboxScore < score) { bboxScore = score; bboxIdx = jj; }
    });
    if (bboxScore > BBOX_SCORE_THRESH) {
      blkList[bboxIdx].lines.push(line);
    } else {
      // no text block: keep only if there is "enough" text mask
      if (maskMean && maskMean(bx1, by1, bx2, by2) < MASK_SCORE_THRESH) continue;
      const blk = makeBlock([bx1, by1, bx2, by2], [line]);
      examineTextblk(blk, imW, imH, false);
      (blk.vertical ? scattered.ver : scattered.hor).push(blk);
    }
  }

  // step 2: filter text blocks, sort & split text lines
  let finalList = [];
  for (const blk of blkList) {
    if (blk.lines.length === 0) {
      const [bx1, by1, bx2, by2] = blk.xyxy;
      if (maskMean && maskMean(bx1, by1, bx2, by2) < MASK_SCORE_THRESH) continue;
      blk.lines = [[[bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]]];
    }
    examineTextblk(blk, imW, imH, true);
    // split manga text if there is a distance gap
    let splitted = false;
    if (blk.lines.length > 1 && (blk.language === "ja" || blk.vertical)) splitted = true;
    let subs = [blk];
    if (splitted) [splitted, subs] = splitTextblk(blk);
    if (!splitted) for (const b of subs) adjustBbox(b, true);
    finalList = finalList.concat(subs);
  }

  // step 3: merge scattered lines, sort text blocks by "grid"
  finalList = finalList.concat(mergeTextlines(scattered.hor), mergeTextlines(scattered.ver));
  if (sortBlklist) finalList = sortTextblkList(finalList, imW, imH);

  for (const blk of finalList) {
    if (blk.language === "eng" && !blk.vertical) {
      if (blk.lines.length === 0) continue;
      const expand = Math.max(Math.trunc(blk.fontSize * 0.1), 2);
      const rad = blk.angle * DEG2RAD;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      blk.lines = blk.lines.map((l) =>
        l.map(([x, y], i) => [
          Math.trunc(Math.min(Math.max(x + corners[i][0] * Math.sin(rad) * expand, 0), imW - 1)),
          Math.trunc(Math.min(Math.max(y + corners[i][1] * Math.cos(rad) * expand, 0), imH - 1)),
        ]));
      blk.fontSize += expand;
    }
  }

  return finalList.map((b) => ({
    xyxy: b.xyxy, lines: b.lines, vertical: b.vertical, fontSize: b.fontSize, angle: b.angle, language: b.language,
  }));
}

// Detected text bubbles: dedupe and manga reading order.
// Port of helper/src/anki_manga_helper/boxes.py. A bubble is the JSON shape
// { id, box: [x1, y1, x2, y2], vertical, font_size, lines: [[x, y] x4][] }.

export function bubbleToJson(b) {
  return {
    id: Number(b.id),
    box: b.box.map(Number),
    vertical: Boolean(b.vertical),
    font_size: Number(b.font_size),
    lines: (b.lines ?? []).map((quad) => quad.map(([x, y]) => [Number(x), Number(y)])),
  };
}

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

function intersection(a, b) {
  return area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
}

function isDuplicate(a, b, iou) {
  const inter = intersection(a, b);
  if (inter <= 0) return false;
  const union = area(a) + area(b) - inter;
  if (union > 0 && inter / union >= iou) return true;
  const smaller = Math.min(area(a), area(b));
  return smaller > 0 && inter / smaller >= 0.9;
}

// Drop boxes that duplicate (IoU >= iou) or sit >= 90% inside a larger one.
export function mergeDuplicates(bubbles, iou = 0.6) {
  const kept = [];
  for (const cand of [...bubbles].sort((a, b) => area(b.box) - area(a.box))) {
    if (!kept.some((k) => isDuplicate(cand.box, k.box, iou))) kept.push(cand);
  }
  return kept;
}

// Rows top->bottom (a bubble joins a row if its centre-y lies in the row's y-span),
// right->left inside a row; ids are reassigned 0..n-1.
export function readingOrder(bubbles, pageWidth) {
  const rows = []; // { top, bottom, members }
  for (const bub of [...bubbles].sort((a, b) => a.box[1] - b.box[1])) {
    const cy = (bub.box[1] + bub.box[3]) / 2;
    const row = rows.find((r) => r.top <= cy && cy <= r.bottom);
    if (row) {
      row.members.push(bub);
      row.top = Math.min(row.top, bub.box[1]);
      row.bottom = Math.max(row.bottom, bub.box[3]);
    } else {
      rows.push({ top: bub.box[1], bottom: bub.box[3], members: [bub] });
    }
  }
  rows.sort((a, b) => a.top - b.top);
  const ordered = rows.flatMap((r) => [...r.members].sort((a, b) => b.box[2] - a.box[2]));
  return ordered.map((m, i) => ({ ...m, id: i }));
}

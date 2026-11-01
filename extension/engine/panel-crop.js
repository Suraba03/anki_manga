// Find the comic panel around a bubble and encode a small JPEG of it. Port of the helper's panel_crop.py.
// Gutter-based: light pixels connected to the page edge are gutter; every other large connected region is a
// panel (bubbles that cross a gutter just merge neighbouring panels). The geometry is pure (RGBA in, box out);
// only cropJpeg needs OffscreenCanvas.

const MIN_PANEL_FRACTION = 0.03;
const GUTTER_LIGHTNESS = 180;
const FALLBACK_GROW = 0.75;
const OPEN_RADIUS = 2; // 5x5 opening

// 8-connected components of a 0/1 mask. labels[i] is 0 for background, else the 1-based component number;
// stats[k] = {x1, y1, x2, y2 (exclusive)} of component k+1.
function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stats = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = stats.length + 1;
    const s = { x1: w, y1: h, x2: 0, y2: 0 };
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    while (top) {
      const p = stack[--top];
      const x = p % w, y = (p - x) / w;
      if (x < s.x1) s.x1 = x;
      if (x + 1 > s.x2) s.x2 = x + 1;
      if (y < s.y1) s.y1 = y;
      if (y + 1 > s.y2) s.y2 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = id;
            stack[top++] = q;
          }
        }
      }
    }
    stats.push(s);
  }
  return { labels, stats };
}

// Separable min (erode, outside counts as set) or max (dilate, outside counts as clear) over a (2r+1)^2 square.
function morph(src, w, h, r, erode) {
  const pass = (from, to, len, lines, stride, step) => {
    for (let line = 0; line < lines; line++) {
      const base = line * stride;
      for (let i = 0; i < len; i++) {
        let v = erode ? 1 : 0;
        for (let k = -r; k <= r; k++) {
          const j = i + k;
          if (j < 0 || j >= len) continue;
          const b = from[base + j * step];
          if (erode ? !b : b) { v = erode ? 0 : 1; break; }
        }
        to[base + i * step] = v;
      }
    }
  };
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  pass(src, tmp, w, h, w, 1); // rows
  pass(tmp, out, h, w, 1, w); // columns
  return out;
}

function fallback(w, h, [x1, y1, x2, y2]) {
  const grow = FALLBACK_GROW * Math.max(x2 - x1, y2 - y1);
  return [
    Math.trunc(Math.max(0, x1 - grow)),
    Math.trunc(Math.max(0, y1 - grow)),
    Math.trunc(Math.min(w, x2 + grow)),
    Math.trunc(Math.min(h, y2 + grow)),
  ];
}

// rgba: {data, width, height}; box: the bubble's [x1, y1, x2, y2]. Returns the smallest panel holding the
// bubble's centre, else the bubble box grown by 0.75x.
export function findPanelBox(rgba, box) {
  const { data, width: w, height: h } = rgba;
  const light = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const gray = (data[i * 4] * 4899 + data[i * 4 + 1] * 9617 + data[i * 4 + 2] * 1868 + 8192) >> 14; // cv2 RGB2GRAY
    light[i] = gray > GUTTER_LIGHTNESS ? 1 : 0;
  }
  const { labels, stats } = components(light, w, h);
  const edge = new Uint8Array(stats.length + 1);
  for (let x = 0; x < w; x++) { edge[labels[x]] = 1; edge[labels[(h - 1) * w + x]] = 1; }
  for (let y = 0; y < h; y++) { edge[labels[y * w]] = 1; edge[labels[y * w + w - 1]] = 1; }
  const notGutter = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) notGutter[i] = labels[i] === 0 || !edge[labels[i]] ? 1 : 0;
  const opened = morph(morph(notGutter, w, h, OPEN_RADIUS, true), w, h, OPEN_RADIUS, false);
  const panels = components(opened, w, h).stats;

  const cx = Math.trunc((box[0] + box[2]) / 2);
  const cy = Math.trunc((box[1] + box[3]) / 2);
  let best = null;
  for (const p of panels) {
    const bw = p.x2 - p.x1, bh = p.y2 - p.y1;
    if (bw * bh < MIN_PANEL_FRACTION * w * h) continue;
    if (!(p.x1 <= cx && cx < p.x2 && p.y1 <= cy && cy < p.y2)) continue;
    if (!best || bw * bh < (best.x2 - best.x1) * (best.y2 - best.y1)) best = p;
  }
  return best ? [best.x1, best.y1, best.x2, best.y2] : fallback(w, h, box);
}

// Output size of a crop whose long side is brought to maxSide (smaller crops are enlarged, like the helper).
export function scaledSize([x1, y1, x2, y2], maxSide = 600) {
  const cw = x2 - x1, ch = y2 - y1;
  const scale = maxSide / Math.max(cw, ch);
  return { width: Math.max(1, Math.round(cw * scale)), height: Math.max(1, Math.round(ch * scale)) };
}

// Offscreen document only. source: an ImageBitmap or {data, width, height} RGBA. Resolves the JPEG as base64.
export async function cropJpeg(source, box, maxSide = 600, quality = 0.8) {
  const width = source.width, height = source.height;
  const x1 = Math.max(0, Math.trunc(box[0])), y1 = Math.max(0, Math.trunc(box[1]));
  const x2 = Math.min(width, Math.trunc(box[2])), y2 = Math.min(height, Math.trunc(box[3]));
  const cw = x2 - x1, ch = y2 - y1;
  const { width: tw, height: th } = scaledSize([x1, y1, x2, y2], maxSide);
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = "high";
  if (source.data) {
    const part = new OffscreenCanvas(cw, ch);
    part.getContext("2d").putImageData(new ImageData(source.data, width, height), -x1, -y1, x1, y1, cw, ch);
    ctx.drawImage(part, 0, 0, tw, th);
  } else {
    ctx.drawImage(source, x1, y1, cw, ch, 0, 0, tw, th);
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

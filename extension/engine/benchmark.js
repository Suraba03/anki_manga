// One-time speed check that decides prefetch vs on-demand OCR on slow machines.

const PAGE_W = 1000, PAGE_H = 1400;
const BUBBLES_PER_PAGE = 12; // bubbles OCR'd per page, assumed
const PREFETCH_UNDER_MS = 6000;
const FALLBACK_BOX = [100, 100, 300, 400]; // used when the detector finds nothing on the synthetic page

// Synthetic 1000x1400 RGBA page: white, with three regions of black vertical strokes that look like text columns.
export function makeBenchmarkPage() {
  const width = PAGE_W, height = PAGE_H;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const fill = (x1, y1, x2, y2) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) data[(y * width + x) * 4] = data[(y * width + x) * 4 + 1] = data[(y * width + x) * 4 + 2] = 0;
  };
  for (const [rx, ry, rw, rh] of [[100, 100, 200, 300], [600, 250, 240, 340], [300, 800, 280, 400]]) {
    for (let cx = rx; cx + 14 <= rx + rw; cx += 28) { // one text column per 28 px
      for (let cy = ry; cy + 20 <= ry + rh; cy += 30) fill(cx, cy, cx + 14, cy + 20); // glyph-sized strokes
      fill(cx + 5, ry, cx + 8, ry + rh); // column stem
    }
  }
  return { data, width, height };
}

// engine: {detect(rgba), ocr(rgba, bubble)}. msPerPage = detect + 12 x one OCR (a page holds about 12 bubbles).
export async function runBenchmark(engine, rgba, { now = () => performance.now() } = {}) {
  const t0 = now();
  const bubbles = await engine.detect(rgba);
  const t1 = now();
  await engine.ocr(rgba, bubbles[0] ?? { box: FALLBACK_BOX });
  const t2 = now();
  const msPerPage = (t1 - t0) + BUBBLES_PER_PAGE * (t2 - t1);
  return { msPerPage, mode: msPerPage < PREFETCH_UNDER_MS ? "prefetch" : "on-demand" };
}

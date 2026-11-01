// Pure pre-processing: RGBA pixels -> model input tensors. No DOM, no dependencies.
// Ports of what the Python helper does, so JS and Python texts agree:
//  - detector: comic_text_detector letterbox (cv2.resize INTER_LINEAR, pad right/bottom with 0)
//  - OCR: manga_ocr crop -> PIL convert("L").convert("RGB") -> ViTImageProcessor
//    (PIL BILINEAR 224x224, rescale 1/255, normalize mean 0.5 / std 0.5)

// Python's round(): halves go to the even neighbour.
function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// cv2.resize INTER_LINEAR on interleaved RGBA, RGB channels only: half-pixel centres, edge clamp, no
// antialiasing, uint8 output. Returns tightly packed RGB (3 bytes per pixel).
function resizeLinearCv(src, sw, sh, dw, dh) {
  // Reductions match cv2 only with the interpolation weight rounded to 1/256 (its 8-bit fixed-point
  // path); enlargements are within one grey level of the unquantised weight.
  const quant = dw < sw || dh < sh;
  const axis = (n, m) => {
    const i0 = new Int32Array(m), i1 = new Int32Array(m), f = new Float64Array(m);
    const s = n / m;
    for (let d = 0; d < m; d++) {
      let x = (d + 0.5) * s - 0.5;
      let x0 = Math.floor(x);
      let fr = x - x0;
      if (x0 < 0) { x0 = 0; fr = 0; }
      if (x0 >= n - 1) { x0 = n - 1; fr = 0; }
      if (quant) fr = Math.floor(fr * 256 + 0.5) / 256;
      i0[d] = x0; i1[d] = Math.min(x0 + 1, n - 1); f[d] = fr;
    }
    return { i0, i1, f };
  };
  const ax = axis(sw, dw), ay = axis(sh, dh);
  // OpenCV (the version the helper runs) filters vertically first and rounds to uint8 between the passes.
  const mid = new Uint8ClampedArray(sw * dh * 3); // dh rows, sw columns, RGB
  for (let y = 0; y < dh; y++) {
    const r0 = ay.i0[y] * sw * 4, r1 = ay.i1[y] * sw * 4, t = ay.f[y];
    for (let x = 0; x < sw; x++) {
      for (let c = 0; c < 3; c++) {
        const a = src[r0 + x * 4 + c], b = src[r1 + x * 4 + c];
        mid[(y * sw + x) * 3 + c] = Math.floor(a + (b - a) * t + 0.5);
      }
    }
  }
  const out = new Uint8ClampedArray(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const base = y * sw * 3;
    for (let x = 0; x < dw; x++) {
      const a = base + ax.i0[x] * 3, b = base + ax.i1[x] * 3, t = ax.f[x];
      for (let c = 0; c < 3; c++) out[(y * dw + x) * 3 + c] = Math.floor(mid[a + c] + (mid[b + c] - mid[a + c]) * t + 0.5);
    }
  }
  return out;
}

export function rgbaToDetInput({ data, width, height }, size = 1024) {
  const scale = Math.min(size / height, size / width);
  const newW = roundHalfEven(width * scale), newH = roundHalfEven(height * scale);
  const padW = size - newW, padH = size - newH;

  let rgb;
  if (newW === width && newH === height) {
    rgb = new Uint8ClampedArray(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
    }
  } else {
    rgb = resizeLinearCv(data, width, height, newW, newH);
  }

  const plane = size * size;
  const tensor = new Float32Array(3 * plane); // pad stays 0
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const s = (y * newW + x) * 3, d = y * size + x;
      tensor[d] = rgb[s] / 255;
      tensor[plane + d] = rgb[s + 1] / 255;
      tensor[2 * plane + d] = rgb[s + 2] / 255;
    }
  }
  return { tensor, scale, padW, padH };
}

// Pillow's BILINEAR resample coefficients (ImagingResample): triangle filter whose support grows with
// the reduction factor (antialiasing), normalised, in 22-bit fixed point.
const PRECISION_BITS = 22;
function pilCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = filterScale; // bilinear filter support is 1
  const starts = new Int32Array(outSize), counts = new Int32Array(outSize);
  const weights = [];
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    const k = new Float64Array(xmax);
    let sum = 0;
    for (let x = 0; x < xmax; x++) {
      const d = Math.abs((x + xmin - center + 0.5) / filterScale);
      const w = d < 1 ? 1 - d : 0;
      k[x] = w;
      sum += w;
    }
    const fixed = new Int32Array(xmax);
    for (let x = 0; x < xmax; x++) {
      const w = sum !== 0 ? k[x] / sum : k[x];
      fixed[x] = Math.trunc(w * (1 << PRECISION_BITS) + (w < 0 ? -0.5 : 0.5));
    }
    starts[xx] = xmin; counts[xx] = xmax; weights.push(fixed);
  }
  return { starts, counts, weights };
}

const clip8 = (v) => {
  const r = Math.floor((v + (1 << (PRECISION_BITS - 1))) / (1 << PRECISION_BITS));
  return r < 0 ? 0 : r > 255 ? 255 : r;
};

// PIL Image.resize(..., BILINEAR) on one 8-bit plane: horizontal pass, then vertical, uint8 in between.
function resizePil(plane, sw, sh, dw, dh) {
  const cx = pilCoeffs(sw, dw), cy = pilCoeffs(sh, dh);
  const tmp = new Uint8Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const k = cx.weights[x], x0 = cx.starts[x];
      let acc = 0;
      for (let i = 0; i < k.length; i++) acc += plane[y * sw + x0 + i] * k[i];
      tmp[y * dw + x] = clip8(acc);
    }
  }
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const k = cy.weights[y], y0 = cy.starts[y];
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let i = 0; i < k.length; i++) acc += tmp[(y0 + i) * dw + x] * k[i];
      out[y * dw + x] = clip8(acc);
    }
  }
  return out;
}

const OCR_SIZE = 224;

export function cropToOcrInput({ data, width, height }, box, pad = 4) {
  const [bx1, by1, bx2, by2] = box;
  // Same truncation and clamping as helper engine.py ocr().
  const x0 = Math.max(0, Math.trunc(bx1) - pad), x1 = Math.min(width, Math.trunc(bx2) + pad);
  const y0 = Math.max(0, Math.trunc(by1) - pad), y1 = Math.min(height, Math.trunc(by2) + pad);
  const cw = x1 - x0, ch = y1 - y0;
  if (!(cw > 0 && ch > 0)) throw new Error("empty OCR crop");

  const gray = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = ((y0 + y) * width + x0 + x) * 4;
      // Pillow's "L" conversion, integer arithmetic.
      gray[y * cw + x] = (data[p] * 19595 + data[p + 1] * 38470 + data[p + 2] * 7471 + 0x8000) >> 16;
    }
  }
  const small = cw === OCR_SIZE && ch === OCR_SIZE ? gray : resizePil(gray, cw, ch, OCR_SIZE, OCR_SIZE);

  const plane = OCR_SIZE * OCR_SIZE;
  const out = new Float32Array(3 * plane);
  const rescale = 1 / 255; // preprocessor_config.json rescale_factor
  for (let i = 0; i < plane; i++) {
    const v = (small[i] * rescale - 0.5) / 0.5; // mean 0.5, std 0.5
    out[i] = v; out[plane + i] = v; out[2 * plane + i] = v;
  }
  return out;
}

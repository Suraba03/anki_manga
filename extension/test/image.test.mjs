import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rgbaToDetInput, cropToOcrInput } from "../engine/image.js";

const ref = JSON.parse(readFileSync(new URL("./fixtures/preprocess-reference.json", import.meta.url), "utf8"));

function solid(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, a], i * 4);
  return { data, width: w, height: h };
}

// Same formula as tools/gen-preprocess-fixtures.py synth().
function synth(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        data[(y * w + x) * 4 + c] = (x * 31 + y * 17 + c * 53 + ((x * y) % 97) * 3 + (((x >> 3) ^ (y >> 2)) & 15) * 5) & 255;
      }
      data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function compare(tensor, { idx, val }, tol) {
  let worst = 0, sum = 0;
  idx.forEach((i, k) => {
    const d = Math.abs(tensor[i] - val[k]);
    worst = Math.max(worst, d);
    sum += d;
  });
  return { worst, mean: sum / idx.length };
}

test("detector letterbox on a 2000x1000 white image", () => {
  const { tensor, scale, padW, padH } = rgbaToDetInput(solid(2000, 1000, [255, 255, 255]));
  assert.equal(tensor.length, 3 * 1024 * 1024);
  assert.ok(tensor instanceof Float32Array);
  assert.equal(scale, 0.512);
  assert.equal(padW, 0);
  assert.equal(padH, 512);
  const plane = 1024 * 1024;
  for (let c = 0; c < 3; c++) {
    assert.equal(tensor[c * plane], 1); // top-left
    assert.equal(tensor[c * plane + 511 * 1024 + 1023], 1); // last image row
    assert.equal(tensor[c * plane + 512 * 1024], 0); // first pad row
    assert.equal(tensor[c * plane + 1023 * 1024 + 1023], 0);
  }
});

test("detector letterbox is CHW, RGB order, alpha ignored", () => {
  const { tensor } = rgbaToDetInput(solid(1024, 1024, [255, 0, 51, 7]));
  const plane = 1024 * 1024;
  assert.equal(tensor[0], 1);
  assert.equal(tensor[plane], 0);
  assert.ok(Math.abs(tensor[2 * plane] - 0.2) < 1e-6);
});

test("detector letterbox pads on the right when the page is tall", () => {
  const { tensor, scale, padW, padH } = rgbaToDetInput(solid(500, 1000, [255, 255, 255]), 1024);
  assert.equal(scale, 1.024);
  assert.equal(padW, 512);
  assert.equal(padH, 0);
  assert.equal(tensor[511], 1);
  assert.equal(tensor[512], 0);
});

for (const c of ref.det) {
  test(`detector letterbox matches Python preprocess_img (${c.w}x${c.h} -> ${c.size})`, () => {
    const { tensor, scale, padW, padH } = rgbaToDetInput(synth(c.w, c.h), c.size);
    assert.ok(Math.abs(scale - c.scale) < 1e-12, `scale ${scale} vs ${c.scale}`);
    assert.equal(padW, c.padW);
    assert.equal(padH, c.padH);
    const { worst, mean } = compare(tensor, c.ref);
    // cv2 resizes in uint8 fixed point; allow one grey level.
    assert.ok(worst <= 1.01 / 255, `worst abs diff ${worst}`);
    assert.ok(mean < 0.2 / 255, `mean abs diff ${mean}`);
  });
}

test("OCR crop of a solid gray image is ~0.0039 everywhere", () => {
  const out = cropToOcrInput(solid(300, 200, [128, 128, 128]), [50, 40, 200, 150]);
  assert.equal(out.length, 3 * 224 * 224);
  assert.ok(out instanceof Float32Array);
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i] - 0.0039) < 0.01, `value ${out[i]} at ${i}`);
});

test("OCR crop: white -> 1, black -> -1, channels identical", () => {
  const white = cropToOcrInput(solid(60, 60, [255, 255, 255]), [10, 10, 40, 40]);
  assert.ok(white.every((v) => v === 1));
  const black = cropToOcrInput(solid(60, 60, [0, 0, 0]), [10, 10, 40, 40]);
  assert.ok(black.every((v) => v === -1));
  const col = cropToOcrInput(synth(80, 60), [10, 10, 70, 50]);
  const plane = 224 * 224;
  for (let i = 0; i < plane; i++) {
    assert.equal(col[i], col[plane + i]);
    assert.equal(col[i], col[2 * plane + i]);
  }
});

test("OCR crop clamps a box that sticks out of the image", () => {
  const out = cropToOcrInput(solid(20, 20, [255, 255, 255]), [-50, -50, 500, 500]);
  assert.ok(out.every((v) => v === 1));
});

for (const c of ref.ocr) {
  test(`OCR crop matches manga_ocr preprocessing (${c.w}x${c.h}, box ${c.box.join(",")})`, () => {
    const out = cropToOcrInput(synth(c.w, c.h), c.box);
    const { worst, mean } = compare(out, c.ref);
    // PIL works in uint8, so a one-level rounding flip is 2/255 in [-1, 1].
    assert.ok(worst <= 2.01 / 255, `worst abs diff ${worst}`);
    assert.ok(mean < 0.3 / 255, `mean abs diff ${mean}`);
  });
}

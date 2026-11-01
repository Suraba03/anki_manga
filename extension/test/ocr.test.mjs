import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { greedyDecode, tokensToText, postprocess } from "../engine/ocr.js";

const ref = JSON.parse(readFileSync(new URL("./fixtures/preprocess-reference.json", import.meta.url), "utf8"));

test("postprocess: spec examples", () => {
  assert.equal(postprocess("ん?"), "ん？");
  assert.equal(postprocess("でも今回の…"), "でも今回の．．．");
  assert.equal(postprocess("手紙......?"), "手紙．．．．．．？");
  assert.equal(postprocess("あ !"), "あ！");
  assert.equal(postprocess("ｶﾞﾝﾊﾞﾚ"), "ガンバレ");
});

test("postprocess: whitespace set matches Python str.split()", () => {
  assert.equal(postprocess("あ\u0085い"), "あい"); // NEL: whitespace in Python, not in JS \s
  assert.equal(postprocess("あ\u001fい"), "あい");
  assert.equal(postprocess("あ\u00a0\u3000\u2003い"), "あい");
  assert.equal(postprocess("あ\ufeffい"), "あ\ufeffい"); // in JS \s, but not whitespace in Python
});

for (const { in: input, out } of ref.post) {
  test(`postprocess matches manga_ocr post_process: ${JSON.stringify(input)}`, () => {
    assert.equal(postprocess(input), out);
  });
}

test("greedyDecode stops at the end token and drops it", async () => {
  const script = [5, 6, 3];
  const seen = [];
  const out = await greedyDecode(async (ids) => {
    seen.push([...ids]);
    const logits = new Float32Array(10);
    logits[script[ids.length - 1]] = 1;
    return logits;
  });
  assert.deepEqual(out, [5, 6]);
  assert.deepEqual(seen, [[2], [2, 5], [2, 5, 6]]);
});

test("greedyDecode stops at maxLen when the end token never comes", async () => {
  let calls = 0;
  const out = await greedyDecode(async () => {
    calls++;
    const logits = new Float32Array(10);
    logits[7] = 1;
    return logits;
  }, { maxLen: 4 });
  assert.deepEqual(out, [7, 7, 7, 7]);
  assert.equal(calls, 4);
});

test("greedyDecode honours custom start/end ids", async () => {
  const starts = [];
  const out = await greedyDecode(async (ids) => {
    starts.push(ids[0]);
    const logits = new Float32Array(6);
    logits[ids.length === 1 ? 4 : 1] = 2;
    return logits;
  }, { start: 9, end: 1 });
  assert.deepEqual(out, [4]);
  assert.deepEqual(starts, [9, 9]);
});

test("greedyDecode picks the first of tied maxima (argmax like torch)", async () => {
  const out = await greedyDecode(async () => new Float32Array([0, 2, 2, 1]), { maxLen: 2 });
  assert.deepEqual(out, [1, 1]);
});

test("tokensToText drops specials and strips ## continuation marks", () => {
  const vocab = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "こ", "ん", "##に", "##ち", "は", "[unused3]"];
  assert.equal(tokensToText([2, 5, 6, 7, 8, 9, 3], vocab), "こんにちは");
  assert.equal(tokensToText([5, 10, 9], vocab), "こは");
  assert.equal(tokensToText([], vocab), "");
});

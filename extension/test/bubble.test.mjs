import test from "node:test";
import assert from "node:assert/strict";
import { bubbleReply } from "../engine/bubble.js";

const page = { bubbles: [{ id: 0, text: "分かる" }, { id: 1, text: null }, { id: 2, text: "" }] };
const fakeTokenizer = {
  tokenize: (text) => [{ surface: text, reading: "わかる", lemma: text, pos: "動詞" }],
};

function counting() {
  const calls = { n: 0 };
  return { calls, get: async () => { calls.n++; return fakeTokenizer; } };
}

test("a bubble with text gets text, ruby and tokens", async () => {
  const t = counting();
  const r = await bubbleReply(page, 0, t.get);
  assert.deepEqual(r, {
    ok: true,
    text: "分かる",
    rubyHtml: "<ruby>分<rt>わ</rt></ruby>かる",
    tokens: [{ surface: "分かる", reading: "わかる", lemma: "分かる", pos: "動詞" }],
  });
});

test("null text (OCR pending or failed) is text_pending", async () => {
  const t = counting();
  assert.deepEqual(await bubbleReply(page, 1, t.get), { ok: false, error: "text_pending" });
  assert.equal(t.calls.n, 0);
});

test("empty text is a genuine empty answer and never loads the tokenizer", async () => {
  const t = counting();
  assert.deepEqual(await bubbleReply(page, 2, t.get), { ok: true, text: "", rubyHtml: "", tokens: [] });
  assert.equal(t.calls.n, 0);
});

test("unknown page or bubble is unknown_bubble", async () => {
  const t = counting();
  assert.deepEqual(await bubbleReply(page, 9, t.get), { ok: false, error: "unknown_bubble" });
  assert.deepEqual(await bubbleReply(null, 0, t.get), { ok: false, error: "unknown_bubble" });
  assert.equal(t.calls.n, 0);
});

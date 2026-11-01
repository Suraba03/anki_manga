import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createTokenizer } from "../lib/tokenizer.js";
import { segments, rubyHtml, boldWord } from "../lib/text.js";

const require = createRequire(import.meta.url);
const dicPath = fileURLToPath(new URL("../node_modules/kuromoji/dict/", import.meta.url));

let tokenizer;
before(async () => {
  tokenizer = await createTokenizer(require("kuromoji"), dicPath);
});

const ruby = (text) => rubyHtml(text, tokenizer.tokenize(text));
const segs = (text) => segments(tokenizer.tokenize(text));
const bold = (text, word) => boldWord(text, word, tokenizer.tokenize(text));

test("tokens carry surface, hiragana reading, lemma and pos", () => {
  const tokens = tokenizer.tokenize("逃げた");
  assert.deepEqual(tokens[0], { surface: "逃げ", reading: "にげ", lemma: "逃げる", pos: "動詞" });
});

test("readings are hiragana, also for katakana words", () => {
  const tokens = tokenizer.tokenize("コーヒーを飲む");
  assert.equal(tokens[0].reading, "こーひー");
  assert.ok(tokens.every((t) => t.reading === null || !/[\u30a1-\u30f6]/.test(t.reading)));
});

test("ruby basic", () => {
  const html = ruby("道具なのです！");
  assert.ok(html.startsWith("<ruby>道具<rt>どうぐ</rt></ruby>"), html);
  assert.ok(html.endsWith("なのです！"), html);
});

test("okurigana stays outside the ruby", () => {
  assert.equal(ruby("分かる"), "<ruby>分<rt>わ</rt></ruby>かる");
});

test("kana is untouched", () => {
  assert.ok(segs("とかだったしな").every(([, r]) => r === null));
});

test("segments cover the text", () => {
  const text = "これは坂の角度が正確に分かる道具なのです！";
  assert.equal(segs(text).map(([s]) => s).join(""), text);
});

test("ruby escapes html", () => {
  assert.ok(ruby("<b>").includes("&lt;b&gt;"));
});

test("bold inflected word by lemma", () => {
  assert.equal(bold("逃げた真実を", "逃げる"), "<b>逃げ</b>た真実を");
});

test("bold exact word", () => {
  assert.equal(bold("坂の角度が", "角度"), "坂の<b>角度</b>が");
});

test("bold escapes html and leaves text alone when the word is absent", () => {
  assert.equal(bold("<a>坂", "角度"), "&lt;a&gt;坂");
  assert.equal(bold("<a>坂", "坂"), "&lt;a&gt;<b>坂</b>");
});

import test from "node:test";
import assert from "node:assert/strict";
import { KnownWords, stripField } from "../lib/known.js";

const OURS = "Manga Mining (anki_manga)";
const note = (model, fields) => ({
  modelName: model,
  fields: Object.fromEntries(fields.map(([k, v], i) => [k, { value: v, order: i }])),
});

test("stripField handles yomitan basic front, ruby, anki furigana and entities", () => {
  assert.equal(stripField("如何なる"), "如何なる");
  assert.equal(stripField("<ruby>武器<rp>(</rp><rt>ぶき</rt><rp>)</rp></ruby>"), "武器");
  assert.equal(stripField(" 分[わ]かる"), "分かる");
  assert.equal(stripField("&nbsp;角度<br>"), "角度");
  assert.equal(stripField("a&amp;b&lt;&#x41;&#66;"), "a&b<AB");
});

test("first field of foreign note types and the Word field of ours", () => {
  const k = KnownWords.fromNotes(
    [note("Basic", [["Front", "叶わない"], ["Back", "x"]]), note(OURS, [["Word", "角度"], ["Reading", "かくど"]])],
    OURS,
  );
  assert.ok(k.isKnown("叶わない", "かなわない"));
  assert.ok(k.isKnown("角度", "かくど"));
  assert.ok(!k.isKnown("道具", "どうぐ"));
});

test("our model uses the Word field even if it is not first", () => {
  const k = KnownWords.fromNotes([note(OURS, [["Reading", "かくど"], ["Word", "角度"]])], OURS);
  assert.ok(k.isKnown("角度", "かくど"));
});

test("a kana entry matches a kanji word by reading", () => {
  const k = KnownWords.fromNotes([note("Basic", [["Front", "わかる"]])], OURS);
  assert.ok(k.isKnown("分かる", "わかる"));
  assert.ok(k.isKnown("分かる", "ワカル"));
});

test("a kanji entry is not matched by reading", () => {
  const k = KnownWords.fromNotes([note("Basic", [["Front", "橋"]])], OURS);
  assert.ok(!k.isKnown("箸", "はし"));
});

test("add ignores empty words and notes without fields", () => {
  const k = new KnownWords();
  k.add("");
  k.add("猫");
  assert.ok(k.isKnown("猫", ""));
  assert.ok(!k.isKnown("犬", ""));
  assert.doesNotThrow(() => KnownWords.fromNotes([{ modelName: "Basic", fields: {} }, { modelName: "Basic" }], OURS));
});

import test from "node:test";
import assert from "node:assert/strict";
import { Dictionary } from "../lib/dictionary.js";

// Compact format of tools/build-dict.mjs: entries [kanji[], kana[], [[pos[], glosses[]], ...]], index {form: [entryIdx]}.
const FIXTURE = {
  version: "test",
  entries: [
    [["食べる", "喰べる"], ["たべる"], [[["v1", "vt"], ["to eat"]], [["v1", "vt"], ["to live on", "to subsist on"]]]],
    [["橋"], ["はし"], [[["n"], ["bridge"]]]],
    [["箸"], ["はし"], [[["n"], ["chopsticks"]]]],
    [[], ["これ"], [[["pn"], ["this", "this one"]]]],
    [["端"], ["はし", "はた"], [[["n"], ["edge", "end"]]]],
  ],
  index: {
    "食べる": [0],
    "喰べる": [0],
    "たべる": [0],
    "橋": [1],
    "箸": [2],
    "はし": [1, 2, 4],
    "これ": [3],
    "端": [4],
    "はた": [4],
  },
};

const dict = Dictionary.fromJson(FIXTURE);

test("finds 食べる by lemma for the surface 食べ", () => {
  const [hit, ...rest] = dict.lookup({ surface: "食べ", lemma: "食べる", reading: "たべ" });
  assert.deepEqual(rest, []);
  assert.deepEqual(hit, {
    kanji: ["食べる", "喰べる"],
    kana: ["たべる"],
    senses: [
      { pos: ["v1", "vt"], glosses: ["to eat"] },
      { pos: ["v1", "vt"], glosses: ["to live on", "to subsist on"] },
    ],
  });
});

test("a kana-only word is found by its reading (katakana is folded to hiragana)", () => {
  const hits = dict.lookup({ surface: "コレ", lemma: "コレ", reading: "コレ" });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].kana, ["これ"]);
  assert.deepEqual(hits[0].senses[0].glosses, ["this", "this one"]);
});

test("falls back from the lemma to the surface to the reading, first hit wins", () => {
  assert.equal(dict.lookup({ surface: "橋", lemma: "*", reading: "はし" })[0].kanji[0], "橋");
  assert.equal(dict.lookup({ surface: "x", lemma: "x", reading: "はた" })[0].kanji[0], "端");
});

test("homophones come back in dictionary order and the list is capped at 5", () => {
  assert.deepEqual(dict.lookup({ surface: "x", lemma: "x", reading: "はし" }).map((e) => e.kanji[0]), ["橋", "箸", "端"]);
  const many = Dictionary.fromJson({
    version: "t",
    entries: Array.from({ length: 9 }, (_, i) => [[], ["か"], [[["n"], [`g${i}`]]]]),
    index: { か: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  });
  assert.equal(many.lookup({ surface: "か", lemma: "か", reading: "か" }).length, 5);
});

test("an unknown word, empty or missing forms give []", () => {
  assert.deepEqual(dict.lookup({ surface: "ぬるぽ", lemma: "ぬるぽ", reading: "ぬるぽ" }), []);
  assert.deepEqual(dict.lookup({ surface: "", lemma: "", reading: null }), []);
  assert.deepEqual(dict.lookup({}), []);
  assert.deepEqual(dict.lookup({ surface: "toString", lemma: "constructor", reading: "__proto__" }), []);
});

test("fromJson rejects a file that is not the compact format", () => {
  assert.throws(() => Dictionary.fromJson({ words: [] }), /dictionary/);
  assert.throws(() => Dictionary.fromJson(null), /dictionary/);
});

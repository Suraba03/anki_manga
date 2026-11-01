import test from "node:test";
import assert from "node:assert/strict";
import { compactJmdict } from "../../tools/build-dict.mjs";
import { Dictionary } from "../lib/dictionary.js";

const gloss = (...texts) => texts.map((text) => ({ lang: "eng", gloss: undefined, text }));
const raw = {
  version: "3.6.2",
  tags: { n: "noun (common) (futsuumeishi)", v1: "Ichidan verb", vt: "transitive verb", unused: "never referenced" },
  words: [
    { id: 1, kanji: [{ text: "橋", common: false }], kana: [{ text: "はし", common: false }], sense: [{ partOfSpeech: ["n"], gloss: gloss("bridge") }] },
    {
      id: 2,
      kanji: [{ text: "食べる", common: true }, { text: "喰べる", common: false }],
      kana: [{ text: "たべる", common: true }],
      sense: [
        { partOfSpeech: ["v1", "vt"], gloss: gloss("to eat", "to have", "to consume", "to take", "to be fifth") },
        { partOfSpeech: ["v1", "vt"], gloss: gloss("to live on") },
        { partOfSpeech: ["v1"], gloss: gloss("third") },
        { partOfSpeech: ["v1"], gloss: gloss("fourth, dropped") },
      ],
    },
    { id: 3, kanji: [], kana: [{ text: "これ", common: true }], sense: [{ partOfSpeech: ["n"], gloss: [{ lang: "ger", text: "dies" }] }, { partOfSpeech: ["n"], gloss: gloss("this") }] },
  ],
};

test("compact form: common entries first, at most 3 senses of 4 glosses, every form indexed", () => {
  const out = compactJmdict(raw);
  assert.equal(out.version, "3.6.2");
  assert.deepEqual(out.entries[0], [
    ["食べる", "喰べる"],
    ["たべる"],
    [[["v1", "vt"], ["to eat", "to have", "to consume", "to take"]], [["v1", "vt"], ["to live on"]], [["v1"], ["third"]]],
  ]);
  assert.deepEqual(out.entries[1], [[], ["これ"], [[["n"], ["this"]]]]); // the non-English gloss is dropped
  assert.deepEqual(out.entries[2], [["橋"], ["はし"], [[["n"], ["bridge"]]]]);
  assert.deepEqual(out.index, { 食べる: [0], 喰べる: [0], たべる: [0], これ: [1], 橋: [2], はし: [2] });
  assert.deepEqual(out.tags, { n: "noun (common) (futsuumeishi)", v1: "Ichidan verb", vt: "transitive verb" });
});

test("the compact form loads and is found by Dictionary", () => {
  const dict = Dictionary.fromJson(compactJmdict(raw));
  assert.equal(dict.lookup({ surface: "食べ", lemma: "食べる", reading: "たべ" })[0].senses[0].glosses[0], "to eat");
  assert.equal(dict.tags.v1, "Ichidan verb");
});

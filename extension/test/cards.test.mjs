import test from "node:test";
import assert from "node:assert/strict";
import { cardFields } from "../lib/cards.js";

const tok = (surface, reading = null, lemma = surface) => ({ surface, reading, lemma, pos: "名詞" });
const base = {
  word: "角度",
  reading: "かくど",
  meaning: "angle",
  text: "角度が違う",
  tokens: [tok("角度", "かくど"), tok("が"), tok("違う", "ちがう")],
  explanation: null,
  sourceUrl: "https://example.test/a?x=1&y=2",
  sourceTitle: "Chapter <1>",
};

test("escapes meaning, bolds the word, and leaves translation empty for a null explanation", () => {
  const f = cardFields({ ...base, meaning: "<b>angle</b> & more" });
  assert.equal(f.Meaning, "&lt;b&gt;angle&lt;/b&gt; &amp; more");
  assert.equal(f.Sentence, "<b>角度</b>が違う");
  assert.equal(f.SentenceFurigana, "<ruby>角度<rt>かくど</rt></ruby>が<ruby>違<rt>ちが</rt></ruby>う");
  assert.equal(f.SentenceTranslation, "");
  assert.equal(f.Explanation, "");
  assert.equal(f.Word, "角度");
  assert.equal(f.Reading, "かくど");
});

test("source link escapes url and title", () => {
  const f = cardFields(base);
  assert.equal(f.Source, '<a href="https://example.test/a?x=1&amp;y=2">Chapter &lt;1&gt;</a>');
});

test("explanation fills translation and notes", () => {
  const f = cardFields({
    ...base,
    explanation: {
      translation: "The angle <is> off",
      notes: [{ focus: "違う", explanation: "plain form & more" }, { focus: "が", explanation: "subject" }],
      suggestions: [],
    },
  });
  assert.equal(f.SentenceTranslation, "The angle &lt;is&gt; off");
  assert.equal(f.Explanation, "<b>違う</b> — plain form &amp; more<br><b>が</b> — subject<br>");
});

test("field names match the note type", async () => {
  const { FIELDS } = await import("../lib/anki.js");
  assert.deepEqual(Object.keys(cardFields(base)).sort(), FIELDS.filter((n) => n !== "Picture").sort());
});

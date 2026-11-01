// JMdict lookup over the compact file made by tools/build-dict.mjs (Task 14). Pure: the offscreen document
// fetches, verifies and gunzips the file, then hands the parsed object to fromJson.
// Compact format: {version, entries: [[kanji[], kana[], [[pos[], glosses[]], ...]], ...], index: {form: [entryIdx]}}.
// Entries are stored most common first, so ascending index = best first.
import { kataToHira } from "./tokenizer.js";

export const MAX_RESULTS = 5;

export class Dictionary {
  // tags: {pos code: description} for the codes used in the entries (shown next to a sense).
  constructor(entries, index, tags = {}) {
    this._entries = entries;
    this._index = index;
    this.tags = tags;
  }

  static fromJson(obj) {
    if (!obj || !Array.isArray(obj.entries) || !obj.index || typeof obj.index !== "object") throw new Error("bad dictionary file");
    return new Dictionary(obj.entries, obj.index, obj.tags || {});
  }

  _hits(form) {
    if (!form || !Object.hasOwn(this._index, form)) return [];
    return this._index[form];
  }

  // {surface, lemma, reading} of a token -> up to 5 entries {kanji, kana, senses:[{pos, glosses}]}.
  // The first of lemma, surface, reading (katakana folded to hiragana) that is in the dictionary decides.
  lookup({ surface, lemma, reading } = {}) {
    for (const form of [lemma, surface, reading ? kataToHira(reading) : reading]) {
      const ids = this._hits(form);
      if (ids.length) {
        return ids
          .slice(0, MAX_RESULTS)
          .map((i) => this._entries[i])
          .map(([kanji, kana, senses]) => ({ kanji, kana, senses: senses.map(([pos, glosses]) => ({ pos, glosses })) }));
      }
    }
    return [];
  }
}

// Which words a deck already has (works with any note type, no configuration). Port of helper known.py.
import { kataToHira } from "./tokenizer.js";

const RT_RP = /<(rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ANKI_FURI = /\[[^\]]*\]/g;
const TAGS = /<[^>]+>/g;
const KANA_ONLY = /^[぀-ヿー]+$/;

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// The entities that occur in Anki fields (no DOM here: this also runs in the service worker).
function unescapeEntities(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    if (name) return NAMED[name] ?? m;
    const cp = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

export function stripField(value) {
  let v = value.replace(RT_RP, "").replace(ANKI_FURI, "").replace(TAGS, "");
  v = unescapeEntities(v).replace(/ /g, " ");
  return v.replace(/\s+/g, "");
}

export class KnownWords {
  constructor() {
    this.words = new Set();
    this.kanaEntries = new Set();
  }

  static fromNotes(notes, ourModel) {
    const known = new KnownWords();
    for (const n of notes) {
      const fields = n.fields ?? {};
      let raw;
      if (n.modelName === ourModel && "Word" in fields) raw = fields.Word.value;
      else {
        const first = Object.values(fields).reduce((a, f) => (a === null || (f.order ?? 0) < (a.order ?? 0) ? f : a), null);
        if (first === null) continue;
        raw = first.value;
      }
      known.add(stripField(raw));
    }
    return known;
  }

  add(word) {
    if (!word) return;
    this.words.add(word);
    if (KANA_ONLY.test(word)) this.kanaEntries.add(kataToHira(word));
  }

  isKnown(word, reading) {
    return this.words.has(word) || this.kanaEntries.has(kataToHira(reading || ""));
  }
}

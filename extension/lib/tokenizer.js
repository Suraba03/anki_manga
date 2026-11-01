// kuromoji (IPADIC) behind a small interface. The kuromoji object is passed in: the offscreen document
// gets it from the classic vendor/kuromoji/build/kuromoji.js script, tests from node_modules.

// Katakana -> hiragana (ァ-ヶ and the iteration marks), like jaconv.kata2hira.
export function kataToHira(s) {
  return s.replace(/[ァ-ヶヽヾ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const KANJI = /[㐀-鿿々〆豈-﫿]/;
const KANA_ONLY = /^[぀-ヿー]+$/;

function toToken(t) {
  const surface = t.surface_form;
  let reading = null;
  if (t.reading && t.reading !== "*") reading = kataToHira(t.reading);
  else if (KANA_ONLY.test(surface) && !KANJI.test(surface)) reading = kataToHira(surface);
  const lemma = t.basic_form && t.basic_form !== "*" ? t.basic_form : surface;
  return { surface, reading, lemma, pos: t.pos };
}

export function createTokenizer(kuromoji, dicPath) {
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, tokenizer) => {
      if (err) return reject(err);
      resolve({ tokenize: (text) => tokenizer.tokenize(text).map(toToken) });
    });
  });
}

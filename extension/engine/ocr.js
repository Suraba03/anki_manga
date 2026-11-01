// manga-ocr decoding and text post-processing (ports of manga_ocr/ocr.py post_process and HF greedy search).

// Greedy decoding. runDecoder(ids) resolves to the logits for the next token (length = vocab size).
// Returns the generated ids without the start token and without the end token.
export async function greedyDecode(runDecoder, { start = 2, end = 3, maxLen = 300 } = {}) {
  const ids = [start];
  const out = [];
  while (out.length < maxLen) {
    const logits = await runDecoder(ids);
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i; // first max wins, like argmax
    if (best === end) break;
    ids.push(best);
    out.push(best);
  }
  return out;
}

const SPECIAL = /^\[[^[\]]+\]$/; // [PAD] [UNK] [CLS] [SEP] [MASK] [unusedN]

export function tokensToText(ids, vocab) {
  let text = "";
  for (const id of ids) {
    const tok = vocab[id];
    if (tok === undefined || SPECIAL.test(tok)) continue;
    text += tok.startsWith("##") ? tok.slice(2) : tok;
  }
  return text;
}

// Python str.split() whitespace (not JS \s: it has U+001C-U+001F and U+0085, lacks U+FEFF).
const PY_WHITESPACE = /[\t\n\v\f\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

// jaconv.h2z(text, ascii=True, digit=True): tables copied from jaconv/conv_table.py.
const DAKUTEN = {
  "ｶﾞ": "ガ", "ｷﾞ": "ギ", "ｸﾞ": "グ", "ｹﾞ": "ゲ", "ｺﾞ": "ゴ", "ｻﾞ": "ザ", "ｼﾞ": "ジ", "ｽﾞ": "ズ", "ｾﾞ": "ゼ", "ｿﾞ": "ゾ",
  "ﾀﾞ": "ダ", "ﾁﾞ": "ヂ", "ﾂﾞ": "ヅ", "ﾃﾞ": "デ", "ﾄﾞ": "ド", "ﾊﾞ": "バ", "ﾋﾞ": "ビ", "ﾌﾞ": "ブ", "ﾍﾞ": "ベ", "ﾎﾞ": "ボ",
  "ﾊﾟ": "パ", "ﾋﾟ": "ピ", "ﾌﾟ": "プ", "ﾍﾟ": "ペ", "ﾎﾟ": "ポ", "ｳﾞ": "ヴ",
};
const DAKUTEN_RE = new RegExp(Object.keys(DAKUTEN).join("|"), "g");
const HALF_KANA = "ｧｱｨｲｩｳｪｴｫｵｶｷｸｹｺｻｼｽｾｿﾀﾁｯﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓｬﾔｭﾕｮﾖﾗﾘﾙﾚﾛﾜｦﾝｰヮヰヱヵヶヽヾ･｢｣｡､";
const FULL_KANA = "ァアィイゥウェエォオカキクケコサシスセソタチッツテトナニヌネノハヒフヘホマミムメモャヤュユョヨラリルレロワヲンーヮヰヱヵヶヽヾ・「」。、";
const KANA = new Map([...HALF_KANA].map((c, i) => [c, [...FULL_KANA][i]]));

function h2z(text) {
  text = text.replace(DAKUTEN_RE, (m) => DAKUTEN[m]);
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x21 && c <= 0x7e) out += String.fromCodePoint(c + 0xfee0); // ASCII incl. digits
    else if (c === 0x20) out += "　";
    else out += KANA.get(ch) ?? ch;
  }
  return out;
}

export function postprocess(text) {
  text = text.replace(PY_WHITESPACE, "");
  text = text.replaceAll("…", "...");
  text = text.replace(/[・.]{2,}/g, (m) => ".".repeat(m.length));
  return h2z(text);
}

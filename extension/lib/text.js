// Furigana (ruby) for bubble text and bolding a target word in a sentence. Port of the helper's text.py;
// tokens come from lib/tokenizer.js ({surface, reading (hiragana) | null, lemma, pos}).
import { kataToHira } from "./tokenizer.js";

const KANJI = /[㐀-鿿々〆豈-﫿]/;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Strip the kana shared at the start/end of surface and reading; ruby only the core.
function splitOkurigana(surface, reading) {
  const hira = kataToHira(surface);
  const limit = Math.min(surface.length, reading.length);
  let pre = 0;
  while (pre < limit && hira[pre] === reading[pre] && !KANJI.test(surface[pre])) pre++;
  let suf = 0;
  while (suf < limit - pre && hira[hira.length - 1 - suf] === reading[reading.length - 1 - suf] && !KANJI.test(surface[surface.length - 1 - suf])) suf++;
  const coreS = surface.slice(pre, surface.length - suf);
  const coreR = reading.slice(pre, reading.length - suf);
  const out = [];
  if (pre) out.push([surface.slice(0, pre), null]);
  if (coreS) out.push([coreS, coreR || null]);
  if (suf) out.push([surface.slice(surface.length - suf), null]);
  return out;
}

// [[text, ruby | null], ...] covering the tokens' surfaces in order.
export function segments(tokens) {
  const out = [];
  for (const { surface, reading } of tokens) {
    if (reading && KANJI.test(surface)) out.push(...splitOkurigana(surface, reading));
    else out.push([surface, null]);
  }
  return out;
}

export function rubyHtml(text, tokens) {
  return segments(tokens)
    .map(([s, r]) => (r ? `<ruby>${escapeHtml(s)}<rt>${escapeHtml(r)}</rt></ruby>` : escapeHtml(s)))
    .join("");
}

export function boldWord(text, word, tokens) {
  if (word && text.includes(word)) {
    const w = escapeHtml(word);
    return escapeHtml(text).split(w).join(`<b>${w}</b>`);
  }
  return tokens
    .map((t) => (word && (t.lemma === word || t.surface === word) ? `<b>${escapeHtml(t.surface)}</b>` : escapeHtml(t.surface)))
    .join("");
}

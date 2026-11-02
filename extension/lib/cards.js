// Anki note fields for a mined word. Port of the helper's /cards field building.
import { rubyHtml, boldWord, escapeHtml } from "./text.js";

// explanation: parseExplanation() result or null. The Picture field is filled by Anki from addCard's picture.
export function cardFields({ word, reading, meaning, text, tokens, explanation, sourceUrl, sourceTitle }) {
  return {
    Word: escapeHtml(word),
    Reading: escapeHtml(reading),
    Meaning: escapeHtml(meaning),
    Sentence: boldWord(text, word, tokens),
    SentenceFurigana: rubyHtml(text, tokens),
    SentenceTranslation: escapeHtml(explanation?.translation ?? ""),
    Explanation: (explanation?.notes ?? []).map((n) => `<b>${escapeHtml(n.focus)}</b> — ${escapeHtml(n.explanation)}<br>`).join(""),
    Source: `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceTitle)}</a>`,
  };
}

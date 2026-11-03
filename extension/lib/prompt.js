// Bubble-explanation prompt and response parsing. Shared with the free-tier server (Task 13).
// Port of helper/src/anki_manga_helper/deepseek.py. Bump PROMPT_VERSION whenever the prompt changes.
export const PROMPT_VERSION = 1;
export const MAX_NOTES = 5;
export const MAX_SUGGESTIONS = 4;

export const SYSTEM_PROMPT = `You help an English-speaking learner read Japanese manga. The user message is the text of ONE speech bubble (OCR output).
Reply with a single JSON object, in English, with exactly this schema:
{"translation": "natural English translation of the bubble",
 "notes": [{"focus": "the Japanese fragment", "explanation": "why it is written this way"}],
 "suggestions": [{"word": "dictionary form", "reading": "hiragana reading", "meaning": "short English gloss"}]}
Rules:
- notes: 2-5 items about grammar and structure (particles, conjugations, contractions, sentence-final particles, omitted subjects, nuance and tone), not plain word glosses. One or two sentences each.
- suggestions: 2-4 words or set phrases from this bubble most worth learning, in dictionary form; skip trivial words (これ, は, です) and onomatopoeia.
- Keep it short. Output JSON only.`;

export class ExplainError extends Error {
  constructor(kind, detail = "") {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
    this.detail = detail;
  }
}

export function buildMessages(text) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ];
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? "" : String(v));

// raw: a JSON string (LLM message content) or an already-parsed object (free-tier server result).
// The model declined the line (its provider's rules) rather than failing: finish_reason "content_filter", or
// non-empty prose where the JSON should be. A cut answer ("length"), an empty one and fenced or bare JSON are format
// failures, not refusals. Shared by the own-key path and the free-tier server.
export function isRefusal(content, finishReason) {
  if (finishReason === "content_filter") return true;
  if (finishReason === "length" || typeof content !== "string") return false;
  const text = content.trim();
  return text !== "" && !/^[{[`]/.test(text);
}

export function parseExplanation(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ExplainError("bad_response", "invalid JSON");
    }
  }
  if (!isObject(data) || typeof data.translation !== "string") throw new ExplainError("bad_response", "missing translation");
  const notes = list(data.notes)
    .filter((n) => isObject(n) && n.explanation)
    .map((n) => ({ focus: str(n.focus), explanation: str(n.explanation) }))
    .slice(0, MAX_NOTES);
  const suggestions = list(data.suggestions)
    .filter((s) => isObject(s) && s.word && s.reading)
    .map((s) => ({ word: str(s.word), reading: str(s.reading), meaning: str(s.meaning) }))
    .slice(0, MAX_SUGGESTIONS);
  return { translation: data.translation, notes, suggestions };
}

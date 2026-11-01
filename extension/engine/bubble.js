// Reply of eng:bubble, kept pure so Node can test it. page: the stored page (or null); getTokenizer loads
// the tokenizer lazily and is not called when there is nothing to tokenize.
import { rubyHtml } from "../lib/text.js";

export async function bubbleReply(page, bubbleId, getTokenizer) {
  const bubble = page?.bubbles.find((b) => b.id === bubbleId);
  if (!bubble) return { ok: false, error: "unknown_bubble" };
  if (bubble.text == null) return { ok: false, error: "text_pending" }; // OCR pending, or failed without being stored
  if (bubble.text === "") return { ok: true, text: "", rubyHtml: "", tokens: [] };
  const tokens = (await getTokenizer()).tokenize(bubble.text);
  return { ok: true, text: bubble.text, rubyHtml: rubyHtml(bubble.text, tokens), tokens };
}

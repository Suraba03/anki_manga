// Explanations in the lab without spending a quota. The panel runs in own-key mode with a placeholder key; every
// chat request it makes is answered here (run.mjs intercepts it):
//   stub      a fixed valid explanation (no network)
//   replay    answers recorded earlier, keyed by prompt version + text; a miss falls back to the stub
//   live:N    at most N real calls with the key from ANKI_MANGA_DEEPSEEK_KEY, recorded for replay
// The free-tier server is never called.

export const STUB = {
  translation: "[lab stub] a fixed explanation",
  notes: [{ focus: "lab", explanation: "Fixed text from the lab's stub; no model was asked." }],
  suggestions: [],
};

export function parseLlmMode(arg) {
  if (arg === undefined || arg === "stub") return { mode: "stub" };
  if (arg === "replay") return { mode: "replay" };
  const m = /^live:(\d+)$/.exec(arg ?? "");
  if (m && Number(m[1]) > 0) return { mode: "live", budget: Number(m[1]) };
  throw new Error(`--llm must be stub, replay or live:N (N > 0), got "${arg}"`);
}

export const cacheKey = (promptVersion, text) => `${promptVersion}\n${String(text).normalize("NFKC").trim()}`;

export function createBudget(n) {
  let used = 0;
  return {
    take() {
      if (used >= n) return false;
      used++;
      return true;
    },
    get used() {
      return used;
    },
  };
}

// The text the panel asked about: the user message of an OpenAI-style chat request.
export const userText = (body) => body?.messages?.find((m) => m.role === "user")?.content ?? "";

export const chatPayload = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });

// -> {source, content}: the message content to answer with, and where it came from (listed in the report).
// ctx: {cache: key -> content (mutated by live), promptVersion, budget, callLive(text) -> content}
export async function answerFor(llm, text, { cache, promptVersion, budget, callLive }) {
  const stub = (why) => ({ source: why ? `stub (${why})` : "stub", content: JSON.stringify(STUB) });
  if (llm.mode === "stub") return stub();
  const key = cacheKey(promptVersion, text);
  if (Object.hasOwn(cache, key)) return { source: "replay", content: cache[key] };
  if (llm.mode === "replay") return stub("replay miss");
  if (!budget.take()) return stub("live budget used up");
  try {
    const content = await callLive(text);
    cache[key] = content;
    return { source: "live", content };
  } catch (e) {
    return stub(`live failed: ${e.message}`);
  }
}

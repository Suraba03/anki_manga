// Explains a clicked bubble: local cache first, then the owner's free-tier server or the user's own provider.
import { PROMPT_VERSION, ExplainError, buildMessages, parseExplanation } from "./prompt.js";

export const FREE_URL = ""; // the free-tier server endpoint; filled in with Task 13
const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const FREE_MAX_CHARS = 300;

const fail = (error) => ({ ok: false, error });

async function callFree(text, { settings, fetch, freeUrl }) {
  if (!freeUrl) throw new ExplainError("free_unavailable");
  const sent = Array.from(text).slice(0, FREE_MAX_CHARS).join("");
  let resp;
  let body;
  try {
    resp = await fetch(freeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ install_id: settings.installId, text: sent, prompt_version: PROMPT_VERSION }),
    });
    body = await resp.json().catch(() => null);
  } catch {
    throw new ExplainError("free_unavailable");
  }
  if (resp.status === 429 && (body?.error === "free_daily_limit" || body?.error === "free_monthly_cap")) {
    throw new ExplainError(body.error);
  }
  if (!resp.ok) throw new ExplainError("free_unavailable");
  let result;
  try {
    result = parseExplanation(body?.result);
  } catch {
    throw new ExplainError("free_unavailable");
  }
  const remaining = Number.parseInt(resp.headers.get("X-Free-Remaining") ?? "", 10);
  return { result, remaining: Number.isFinite(remaining) ? remaining : null };
}

async function callOwn(text, { settings, fetch }) {
  const llm = settings.llm;
  if (!llm.apiKey) throw new ExplainError("no_api_key");
  const base = llm.provider === "custom" ? llm.baseUrl.replace(/\/+$/, "") : DEEPSEEK_BASE;
  let resp;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model || DEFAULT_MODEL,
        messages: buildMessages(text),
        response_format: { type: "json_object" },
        max_tokens: 700,
        stream: false,
      }),
    });
  } catch {
    throw new ExplainError("network");
  }
  if (resp.status === 401 || resp.status === 403) throw new ExplainError("auth");
  if (resp.status === 402) throw new ExplainError("no_balance");
  if (resp.status === 429) throw new ExplainError("rate_limited");
  if (resp.status !== 200) throw new ExplainError("bad_response", `HTTP ${resp.status}`);
  let content;
  try {
    content = (await resp.json()).choices[0].message.content;
  } catch {
    throw new ExplainError("bad_response", "unexpected payload");
  }
  return { result: parseExplanation(content), remaining: null };
}

// -> {ok:true, result, cached, remaining} | {ok:false, error}
export async function explain(text, { settings, store, fetch, freeUrl }) {
  if (typeof text !== "string" || !text.trim()) return fail("no_text");
  const key = await store.explanationKey(text);
  const hit = await store.getExplanation(key);
  if (hit) return { ok: true, result: hit, cached: true, remaining: null };
  try {
    const { result, remaining } = await (settings.llm.mode === "own" ? callOwn : callFree)(text, { settings, fetch, freeUrl });
    await store.putExplanation(key, result);
    return { ok: true, result, cached: false, remaining };
  } catch (e) {
    if (e instanceof ExplainError) return fail(e.kind);
    throw e;
  }
}

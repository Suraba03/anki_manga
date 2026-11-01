// Pure request logic of the free tier: validation, quotas, spend cap, shared cache.
// No I/O of its own: the db, the LLM call, the clock and the IP hash are passed in.
import { PROMPT_VERSION, parseExplanation } from "../../extension/lib/prompt.js";

export const MAX_TEXT_CHARS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_VARS = ["DAILY_PER_INSTALL", "DAILY_PER_IP", "MONTHLY_CAP_USD", "PRICE_IN_HIT", "PRICE_IN_MISS", "PRICE_OUT"];
const WARN_FRACTION = 0.8;

// Wrangler vars are strings.
export function parseConfig(env) {
  const config = { ALLOWED_ORIGINS: String(env.ALLOWED_ORIGINS ?? ""), ALLOW_NO_ORIGIN: String(env.ALLOW_NO_ORIGIN ?? "0") };
  for (const name of NUMBER_VARS) {
    const n = Number(env[name]);
    if (env[name] === undefined || env[name] === "" || !Number.isFinite(n)) throw new Error(`bad config var ${name}`);
    config[name] = n;
  }
  return config;
}

// Same key as the extension's store.explanationKey.
export async function explanationKey(text) {
  const bytes = new TextEncoder().encode(`${PROMPT_VERSION}\n${text.normalize("NFKC").trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// origin: the Origin request header or null. An entry ending in "*" is a prefix match.
export function originAllowed(origin, config) {
  if (!origin) return config.ALLOW_NO_ORIGIN === "1";
  return config.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) => (entry.endsWith("*") ? origin.startsWith(entry.slice(0, -1)) : origin === entry));
}

const reply = (status, json, headers = {}) => ({ status, json, headers });
const err = (status, error) => reply(status, { error });
const remainingHeader = (limit, used) => ({ "X-Free-Remaining": String(Math.max(0, limit - used)) });

// body: the parsed JSON. ctx: {db, callLlm(text) -> {result, usage}, now: Date, ipHash, origin, config}
// -> {status, json, headers}
export async function handleExplain(body, { db, callLlm, now, ipHash, origin, config }) {
  if (!originAllowed(origin, config)) return err(403, "forbidden_origin");
  if (body === null || typeof body !== "object" || Array.isArray(body) || body.prompt_version !== PROMPT_VERSION) {
    return err(400, "bad_request");
  }
  if (typeof body.install_id !== "string" || !UUID.test(body.install_id)) return err(400, "bad_install_id");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const length = Array.from(text).length;
  if (length < 1 || length > MAX_TEXT_CHARS) return err(400, "bad_text");

  const installId = body.install_id.toLowerCase();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const installUsed = await db.countInstall(day, installId);
  const key = await explanationKey(text);

  const hit = await db.getCache(key);
  if (hit) return reply(200, { result: hit }, remainingHeader(config.DAILY_PER_INSTALL, installUsed));

  if (installUsed >= config.DAILY_PER_INSTALL || (await db.countIp(day, ipHash)) >= config.DAILY_PER_IP) {
    return err(429, "free_daily_limit");
  }
  const spentBefore = await db.getSpend(month);
  if (spentBefore >= config.MONTHLY_CAP_USD) return err(429, "free_monthly_cap");

  let result;
  let usage;
  try {
    const out = await callLlm(text);
    usage = out.usage;
    result = parseExplanation(out.result);
  } catch {
    return err(502, "free_unavailable");
  }

  const tokens = (name) => Number(usage?.[name]) || 0;
  const cost =
    tokens("prompt_cache_hit_tokens") * config.PRICE_IN_HIT +
    tokens("prompt_cache_miss_tokens") * config.PRICE_IN_MISS +
    tokens("completion_tokens") * config.PRICE_OUT;
  // Separate single-statement UPSERTs: D1 has no cross-statement transaction here, so two
  // concurrent requests can both pass the checks above (a small, accepted overshoot).
  await db.putCache(key, text, result);
  await db.incInstall(day, installId);
  await db.incIp(day, ipHash);
  await db.addSpend(month, cost);

  const warnAt = config.MONTHLY_CAP_USD * WARN_FRACTION;
  if (spentBefore < warnAt && spentBefore + cost >= warnAt) {
    console.warn(`free tier: monthly spend ${(spentBefore + cost).toFixed(4)} USD passed 80% of the ${config.MONTHLY_CAP_USD} USD cap`);
  }
  return reply(200, { result }, remainingHeader(config.DAILY_PER_INSTALL, installUsed + 1));
}

// Cloudflare Worker entry: CORS, D1 adapter, DeepSeek call. The request logic is in explain.js.
import { buildMessages } from "../../extension/lib/prompt.js";
import { prune } from "./prune.js";
import { handleExplain, parseConfig, originAllowed, describeError, checkMonthAlerts } from "./explain.js";
import { makeNotifier, alertText } from "./alerts.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const LLM_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 8192;
const DEFAULT_MODEL = "deepseek-flash";
const DAY_MS = 86400000;

// Same request as the extension's own-key path. -> {result: message content, usage}
export async function callDeepSeek(text, { apiKey, model = DEFAULT_MODEL, fetch: doFetch = fetch, timeoutMs = LLM_TIMEOUT_MS }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await doFetch(DEEPSEEK_URL, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: buildMessages(text),
        response_format: { type: "json_object" },
        max_tokens: 700,
        stream: false,
        // deepseek-flash thinks by default; its reasoning eats the token budget and the JSON comes back cut or blank.
        thinking: { type: "disabled" },
      }),
    });
    if (resp.status !== 200) throw Object.assign(new Error("DeepSeek HTTP error"), { status: resp.status });
    // From here on DeepSeek has billed the call: errors are flagged `paid` so the spend is still charged.
    let data;
    try {
      data = await resp.json();
    } catch {
      throw Object.assign(new Error("DeepSeek: unreadable body"), { paid: true });
    }
    const content = data?.choices?.[0]?.message?.content;
    const finishReason = data?.choices?.[0]?.finish_reason ?? null;
    // A content_filter stop may come without content: it is an answer (a refusal), not a broken payload.
    if (finishReason === "content_filter" && content == null) return { result: "", usage: data.usage, finishReason };
    if (typeof content !== "string") throw Object.assign(new Error("DeepSeek: no content"), { paid: true, usage: data?.usage });
    return { result: content, usage: data.usage, finishReason };
  } finally {
    clearTimeout(timer);
  }
}

// d1: the Workers D1 binding. Counters are single UPSERT statements. The spend adders return the new total from the
// same statement (RETURNING), so exactly one request's charge interval (total - cost, total] contains an alert threshold,
// even with concurrent requests.
export function makeD1Db(d1, nowMs = Date.now) {
  const first = (sql, ...args) => d1.prepare(sql).bind(...args).first();
  const run = (sql, ...args) => d1.prepare(sql).bind(...args).run();
  return {
    getCache: async (key) => {
      const row = await first("SELECT result, created_at, last_used FROM cache WHERE key = ?", key);
      if (!row) return null;
      // Retention: remember a hit, but write at most once a day per row (best effort; a failure must not lose the hit).
      const now = nowMs();
      if (now - (row.last_used ?? row.created_at) > DAY_MS) {
        await run("UPDATE cache SET last_used = ? WHERE key = ?", now, key).catch(() => {});
      }
      return JSON.parse(row.result);
    },
    putCache: (key, text, result) =>
      run("INSERT OR REPLACE INTO cache (key, text, result, created_at) VALUES (?, ?, ?, ?)", key, text, JSON.stringify(result), nowMs()),
    countInstall: async (day, id) => (await first("SELECT n FROM install_counts WHERE day = ? AND id = ?", day, id))?.n ?? 0,
    incInstall: (day, id) =>
      run("INSERT INTO install_counts (day, id, n) VALUES (?, ?, 1) ON CONFLICT (day, id) DO UPDATE SET n = n + 1", day, id),
    countIp: async (day, h) => (await first("SELECT n FROM ip_counts WHERE day = ? AND h = ?", day, h))?.n ?? 0,
    incIp: (day, h) =>
      run("INSERT INTO ip_counts (day, h, n) VALUES (?, ?, 1) ON CONFLICT (day, h) DO UPDATE SET n = n + 1", day, h),
    getSpend: async (month) => (await first("SELECT usd FROM spend WHERE month = ?", month))?.usd ?? 0,
    addSpend: async (month, usd) =>
      (await first("INSERT INTO spend (month, usd) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET usd = usd + excluded.usd RETURNING usd", month, usd))?.usd ?? 0,
    addDaySpend: async (day, usd) =>
      (await first("INSERT INTO spend_days (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd RETURNING usd", day, usd))?.usd ?? 0,
    // true only for the call that inserted the row: that call sends the alert
    claimAlert: async (period, kind, atMs) =>
      (await run("INSERT OR IGNORE INTO alerts (period, kind, sent_at) VALUES (?, ?, ?)", period, kind, atMs))?.meta?.changes === 1,
    // a failed send gives the claim back, so the cron can retry
    releaseAlert: (period, kind) => run("DELETE FROM alerts WHERE period = ? AND kind = ?", period, kind),
  };
}

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function respond(status, json, origin, extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Expose-Headers"] = "X-Free-Remaining";
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(json), { status, headers });
}

// Dev only (env.DEV_ROUTES = "1", never in wrangler.toml): the owner checks that alerts arrive.
async function testAlert(env, deps) {
  const notify = deps.notify !== undefined ? deps.notify : makeNotifier(env, { fetch: deps.alertFetch });
  if (!notify) return respond(500, { error: "no_alert_channel" }, null);
  try {
    await notify(alertText("test", { at: deps.now ?? new Date() }));
    return respond(200, { ok: true }, null);
  } catch (e) {
    console.error("free tier: alert failed:", describeError(e));
    return respond(502, { error: "alert_failed" }, null);
  }
}

// deps (tests): {db, callLlm, now, notify (function or null), waitUntil, alertFetch}
export async function handle(request, env, deps = {}) {
  // Before the Origin check, so plain curl works locally.
  if (env.DEV_ROUTES === "1" && request.method === "POST" && new URL(request.url).pathname === "/dev/test-alert") {
    return testAlert(env, deps);
  }
  const origin = request.headers.get("Origin");
  let config;
  try {
    config = parseConfig(env);
  } catch {
    return respond(500, { error: "server_misconfigured" }, null);
  }
  if (!originAllowed(origin, config)) return respond(403, { error: "forbidden_origin" }, null);
  const cors = origin; // set only for an allowed, present Origin

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin ?? "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }
  const path = new URL(request.url).pathname;
  if (path !== "/explain" && path !== "/") return respond(404, { error: "not_found" }, cors);
  if (request.method !== "POST") return respond(405, { error: "method_not_allowed" }, cors, { Allow: "POST, OPTIONS" });
  if (!env.IP_SALT || !env.DEEPSEEK_API_KEY) return respond(500, { error: "server_misconfigured" }, cors);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) throw new Error("too large");
    body = JSON.parse(raw);
  } catch {
    return respond(400, { error: "bad_request" }, cors);
  }

  try {
    const ipHash = await sha256Hex(env.IP_SALT + (request.headers.get("CF-Connecting-IP") ?? ""));
    const { status, json, headers } = await handleExplain(body, {
      db: deps.db ?? makeD1Db(env.DB),
      callLlm: deps.callLlm ?? ((text) => callDeepSeek(text, { apiKey: env.DEEPSEEK_API_KEY, model: env.LLM_MODEL || DEFAULT_MODEL, fetch: deps.fetch })),
      now: deps.now ?? new Date(),
      ipHash,
      origin,
      config,
      // alert work runs after the response (ctx.waitUntil in production)
      notify: deps.notify !== undefined ? deps.notify : makeNotifier(env, { fetch: deps.alertFetch }),
      waitUntil: deps.waitUntil ?? ((p) => p),
    });
    return respond(status, json, cors, headers);
  } catch (e) {
    console.error("free tier: request failed:", describeError(e));
    return respond(502, { error: "free_unavailable" }, cors);
  }
}

// Cron safety net: sends a monthly alert that was missed or whose send failed.
async function checkAlerts(env) {
  await checkMonthAlerts({ db: makeD1Db(env.DB), config: parseConfig(env), now: new Date(), notify: makeNotifier(env) });
}

export default {
  fetch: (request, env, ctx) => handle(request, env, { waitUntil: (p) => ctx.waitUntil(p) }),
  // Daily cron (wrangler.toml [triggers]): retention cleanup, then the alert check. Separate promises: one failing
  // must not stop the other.
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(prune(env).catch((e) => console.error("free tier: prune failed:", describeError(e))));
    ctx.waitUntil(checkAlerts(env).catch((e) => console.error("free tier: alert check failed:", describeError(e))));
  },
};

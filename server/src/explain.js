// Pure request logic of the free tier: validation, quotas, spend cap, shared cache.
// No I/O of its own: the db, the LLM call, the clock and the IP hash are passed in.
import { PROMPT_VERSION, SYSTEM_PROMPT, parseExplanation, isRefusal } from "../../extension/lib/prompt.js";
import { alertText } from "./alerts.js";

export const MAX_TEXT_CHARS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_VARS = ["DAILY_PER_INSTALL", "DAILY_PER_IP", "MONTHLY_CAP_USD", "PRICE_IN_HIT", "PRICE_IN_MISS", "PRICE_OUT"];
const DEFAULT_FAILED_PER_IP = 20;
const DEFAULT_DAILY_ALERT_FRACTION = 0.25; // of the monthly cap: about 7x a normal day at the cap
// Monthly alerts: [kind, fraction of MONTHLY_CAP_USD]. Order matters: 80% is sent before 100%.
const MONTH_ALERTS = [["month_80", 0.8], ["month_100", 1]];
const MAX_OUTPUT_TOKENS = 700; // the max_tokens worker.js sends

// Wrangler vars are strings.
export function parseConfig(env) {
  const config = { ALLOWED_ORIGINS: String(env.ALLOWED_ORIGINS ?? ""), ALLOW_NO_ORIGIN: String(env.ALLOW_NO_ORIGIN ?? "0") };
  for (const name of NUMBER_VARS) {
    const n = Number(env[name]);
    if (env[name] === undefined || env[name] === "" || !Number.isFinite(n)) throw new Error(`bad config var ${name}`);
    config[name] = n;
  }
  // DAILY_FAILED_PER_IP: paid calls that gave no explanation (a refusal, an unusable answer) per IP per day.
  // Optional; they cost money but use no other quota, so without a ceiling a script could repeat them.
  const failed = env.DAILY_FAILED_PER_IP === undefined || env.DAILY_FAILED_PER_IP === "" ? DEFAULT_FAILED_PER_IP : Number(env.DAILY_FAILED_PER_IP);
  if (!Number.isFinite(failed)) throw new Error("bad config var DAILY_FAILED_PER_IP");
  config.DAILY_FAILED_PER_IP = failed;
  // DAILY_ALERT_USD: one day's spend above this alerts the owner (abuse). Optional.
  const dailyAlert = env.DAILY_ALERT_USD === undefined || env.DAILY_ALERT_USD === "" ? DEFAULT_DAILY_ALERT_FRACTION * config.MONTHLY_CAP_USD : Number(env.DAILY_ALERT_USD);
  if (!Number.isFinite(dailyAlert)) throw new Error("bad config var DAILY_ALERT_USD");
  config.DAILY_ALERT_USD = dailyAlert;
  return config;
}

// Same key as the extension's store.explanationKey.
export async function explanationKey(text) {
  const bytes = new TextEncoder().encode(`${PROMPT_VERSION}\n${text.normalize("NFKC").trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ANY_EXTENSION = "chrome-extension://*";

// origin: the Origin request header or null. Entries are exact origins (wrangler.toml lists the Web Store
// build), except the single wildcard "chrome-extension://*" (any extension; local experiments only).
export function originAllowed(origin, config) {
  if (!origin) return config.ALLOW_NO_ORIGIN === "1";
  return config.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) => (entry === ANY_EXTENSION ? origin.startsWith("chrome-extension://") : origin === entry));
}

// A short, safe description of a caught error for the logs: names and a status, never the message
// (which can carry request text, the key or SQL parameters).
export function describeError(e) {
  return [e?.name, e?.kind, e?.status].filter((v) => v !== undefined && v !== null && v !== "").join(" ") || "unknown";
}

const tokenCount = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// USD for one paid call. Missing or garbage usage is charged a deliberately high estimate
// (max output, and every code point of prompt and text as an input token) so the cap holds.
function costOf(usage, text, config) {
  const hit = tokenCount(usage?.prompt_cache_hit_tokens);
  const miss = tokenCount(usage?.prompt_cache_miss_tokens);
  const out = tokenCount(usage?.completion_tokens) ?? MAX_OUTPUT_TOKENS;
  const input =
    hit !== null && miss !== null
      ? hit * config.PRICE_IN_HIT + miss * config.PRICE_IN_MISS
      : (Array.from(SYSTEM_PROMPT).length + Array.from(text).length) * config.PRICE_IN_MISS;
  return input + out * config.PRICE_OUT;
}

// ---- spend alerts ----
// Claim the (period, kind) row first: only the call that inserted it sends, so an alert goes out once per period
// even with concurrent requests and the cron. A failed send releases the claim so the cron can retry.
// Never throws: alerts must not break the request that triggered them.
async function fireAlert(db, notify, { period, kind, text }, nowMs) {
  try {
    if (!(await db.claimAlert(period, kind, nowMs))) return;
    console.warn(text); // amounts and dates only
    if (!notify) return; // no channel configured: the log line is all there is
    try {
      await notify(text);
    } catch (e) {
      console.error("free tier: alert failed:", describeError(e));
      await db.releaseAlert(period, kind);
    }
  } catch (e) {
    console.error("free tier: alert bookkeeping failed:", describeError(e));
  }
}

const fireAlerts = async (db, notify, alerts, nowMs) => {
  for (const alert of alerts) await fireAlert(db, notify, alert, nowMs);
};

// An interval (total - cost, total] holds the threshold: exactly one of the charges that add up past it sees this.
const crossed = (total, cost, threshold) => total - cost < threshold && threshold <= total;

// The alerts one charge of `cost` triggers. dayTotal: null when the daily total could not be written.
function alertsDue({ month, day, total, dayTotal, cost, config }) {
  const alerts = [];
  for (const [kind, fraction] of MONTH_ALERTS) {
    if (crossed(total, cost, fraction * config.MONTHLY_CAP_USD)) {
      alerts.push({ period: month, kind, text: alertText(kind, { used: total, cap: config.MONTHLY_CAP_USD, month }) });
    }
  }
  if (dayTotal !== null && crossed(dayTotal, cost, config.DAILY_ALERT_USD)) {
    alerts.push({ period: day, kind: "day_spike", text: alertText("day_spike", { usd: dayTotal, day, threshold: config.DAILY_ALERT_USD }) });
  }
  return alerts;
}

// Cron safety net: the monthly alerts whose threshold is already reached and that were never claimed (or whose
// send failed and was released). Not for the daily spike: that is a moment, not a state.
// ctx: {db, config, now: Date, notify: function or null}
export async function checkMonthAlerts({ db, config, now, notify }) {
  if (!(config.MONTHLY_CAP_USD > 0)) return; // no budget to report on (every spend would be "100% of 0")
  const month = now.toISOString().slice(0, 7);
  const used = await db.getSpend(month);
  const due = MONTH_ALERTS.filter(([, fraction]) => used >= fraction * config.MONTHLY_CAP_USD).map(([kind]) => ({
    period: month,
    kind,
    text: alertText(kind, { used, cap: config.MONTHLY_CAP_USD, month }),
  }));
  await fireAlerts(db, notify, due, now.getTime());
}

const reply = (status, json, headers = {}) => ({ status, json, headers });
const err = (status, error) => reply(status, { error });
const remainingHeader = (limit, used) => ({ "X-Free-Remaining": String(Math.max(0, limit - used)) });

// body: the parsed JSON. ctx: {db, callLlm(text) -> {result, usage}, now: Date, ipHash, origin, config,
// notify: async (text) or null (no alert channel), waitUntil(promise): keeps alert work alive after the response}
// -> {status, json, headers}
export async function handleExplain(body, { db, callLlm, now, ipHash, origin, config, notify = null, waitUntil = (p) => p }) {
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

  // Paid calls that gave no explanation (a refusal, an unusable answer, an unreadable 200) are counted in
  // ip_counts under their own "failed:" key, so they never eat the normal per-IP allowance (the daily cron
  // prunes them with the rest). They are not cached, so a script could otherwise repeat them for free.
  const failedKey = `failed:${ipHash}`;
  if (
    installUsed >= config.DAILY_PER_INSTALL ||
    (await db.countIp(day, ipHash)) >= config.DAILY_PER_IP ||
    (await db.countIp(day, failedKey)) >= config.DAILY_FAILED_PER_IP
  ) {
    return err(429, "free_daily_limit");
  }
  const spentBefore = await db.getSpend(month);
  if (spentBefore >= config.MONTHLY_CAP_USD) return err(429, "free_monthly_cap");

  // Charge the spend of a paid call first: it is the owner's money guarantee, so it must survive
  // a failure of any later write. Separate single-statement UPSERTs: D1 has no cross-statement
  // transaction here, so two concurrent requests can both pass the checks above (a small, accepted overshoot).
  const charge = async (usage) => {
    const cost = costOf(usage, text, config);
    const total = await db.addSpend(month, cost);
    // The daily total only feeds the spike alert: if it fails (say, the table is not migrated yet), the request goes on.
    let dayTotal = null;
    try {
      dayTotal = await db.addDaySpend(day, cost);
    } catch (e) {
      console.error("free tier: daily spend write failed:", describeError(e));
    }
    // After the money is recorded; not awaited, so a slow or broken alert channel never delays the answer.
    const alerts = alertsDue({ month, day, total, dayTotal, cost, config });
    if (alerts.length > 0) waitUntil(fireAlerts(db, notify, alerts, now.getTime()));
  };

  let out;
  try {
    out = await callLlm(text);
  } catch (e) {
    console.error("free tier: LLM call failed:", describeError(e));
    if (e?.paid) {
      // HTTP 200 but unreadable: DeepSeek billed it
      await charge(e.usage);
      await db.incIp(day, failedKey);
    }
    return err(502, "free_unavailable");
  }
  let result;
  try {
    result = parseExplanation(out?.result);
  } catch (e) {
    const len = typeof out?.result === "string" ? out.result.trim().length : -1;
    // A refusal (the model declined the line) is final: a retry gets the same answer, so it has its own code.
    const refused = isRefusal(out?.result, out?.finishReason);
    console.error(
      `free tier: LLM answer ${refused ? "refused" : "rejected"}:`,
      describeError(e),
      `finish_reason=${out?.finishReason ?? "?"} content_chars=${len}`,
    );
    await charge(out?.usage); // paid, but no install/IP quota use and nothing cached
    await db.incIp(day, failedKey);
    return refused ? err(422, "explanation_refused") : err(502, "free_unavailable");
  }

  await charge(out.usage);
  await db.putCache(key, text, result);
  await db.incInstall(day, installId);
  await db.incIp(day, ipHash);
  return reply(200, { result }, remainingHeader(config.DAILY_PER_INSTALL, installUsed + 1));
}

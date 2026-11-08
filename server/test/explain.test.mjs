import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleExplain, parseConfig, explanationKey, originAllowed, checkMonthAlerts } from "../src/explain.js";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../../extension/lib/prompt.js";

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID2 = "9f1c2d3e-0000-4000-8000-000000000001";
const ORIGIN = "chrome-extension://abcdefghijklmnop";
const NOW = new Date("2026-11-01T12:00:00Z");
const DAY = "2026-11-01";
const MONTH = "2026-11";

const CONFIG = {
  DAILY_PER_INSTALL: 100,
  DAILY_PER_IP: 300,
  DAILY_FAILED_PER_IP: 20,
  MONTHLY_CAP_USD: 10,
  DAILY_ALERT_USD: 2.5,
  PRICE_IN_HIT: 0.000001,
  PRICE_IN_MISS: 0.00001,
  PRICE_OUT: 0.0001,
  ALLOWED_ORIGINS: "chrome-extension://*",
  ALLOW_NO_ORIGIN: "0",
};

const RAW = JSON.stringify({
  translation: "Hello",
  notes: [{ focus: "こんにちは", explanation: "A greeting." }],
  suggestions: [{ word: "挨拶", reading: "あいさつ", meaning: "greeting" }],
});
const PARSED = {
  translation: "Hello",
  notes: [{ focus: "こんにちは", explanation: "A greeting." }],
  suggestions: [{ word: "挨拶", reading: "あいさつ", meaning: "greeting" }],
};
const CUT = '{"translation": "Hel'; // a cut answer: unparseable, but not a refusal
const USAGE = { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20, completion_tokens: 30 };
const COST = 10 * CONFIG.PRICE_IN_HIT + 20 * CONFIG.PRICE_IN_MISS + 30 * CONFIG.PRICE_OUT;

function memoryDb() {
  const cache = new Map();
  const installs = new Map();
  const ips = new Map();
  const spend = new Map();
  const daySpend = new Map();
  const alerts = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  // The adders return the new total, like the single-statement UPSERT ... RETURNING in worker.js.
  const add = (m, k, usd) => (m.set(k, (m.get(k) ?? 0) + usd), m.get(k));
  return {
    cache, installs, ips, spend, daySpend, alerts,
    getCache: async (key) => cache.get(key)?.result ?? null,
    putCache: async (key, text, result) => void cache.set(key, { text, result }),
    countInstall: async (day, id) => installs.get(`${day}|${id}`) ?? 0,
    incInstall: async (day, id) => bump(installs, `${day}|${id}`),
    countIp: async (day, h) => ips.get(`${day}|${h}`) ?? 0,
    incIp: async (day, h) => bump(ips, `${day}|${h}`),
    getSpend: async (month) => spend.get(month) ?? 0,
    addSpend: async (month, usd) => add(spend, month, usd),
    addDaySpend: async (day, usd) => add(daySpend, day, usd),
    claimAlert: async (period, kind) => !alerts.has(`${period}|${kind}`) && (alerts.set(`${period}|${kind}`, true), true),
    releaseAlert: async (period, kind) => void alerts.delete(`${period}|${kind}`),
  };
}

function setup(over = {}) {
  const db = memoryDb();
  const calls = [];
  const pending = []; // promises handed to waitUntil: the alert work
  const ctx = {
    db,
    callLlm: async (text) => {
      calls.push(text);
      return { result: RAW, usage: USAGE };
    },
    now: NOW,
    ipHash: "iphash",
    origin: ORIGIN,
    config: CONFIG,
    notify: null,
    waitUntil: (p) => pending.push(p),
    ...over,
  };
  return { db, calls, pending, ctx };
}

const body = (over = {}) => ({ install_id: ID, text: "こんにちは", prompt_version: PROMPT_VERSION, ...over });
// Failure paths log a short cause with console.error; keep the test output clean and let tests inspect it.
let errors;
beforeEach(() => {
  errors = mock.method(console, "error", () => {});
});
afterEach(() => errors.mock.restore());

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("explanationKey matches the extension: sha256 of version, newline and trimmed NFKC text", async () => {
  assert.equal(await explanationKey("  ｱｲ \n"), sha("1\nアイ"));
});

test("empty, blank or over-300-char text is 400 bad_text", async () => {
  for (const text of ["", "   \n", "あ".repeat(301), "😀".repeat(301), 5, null]) {
    const { ctx, calls } = setup();
    const r = await handleExplain(body({ text }), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_text");
    assert.equal(calls.length, 0);
  }
});

test("exactly 300 characters, astral ones counted as one, is accepted", async () => {
  const { ctx } = setup();
  assert.equal((await handleExplain(body({ text: "😀".repeat(300) }), ctx)).status, 200);
});

test("a bad install_id is 400 bad_install_id", async () => {
  for (const install_id of ["", "nope", 7, undefined, `${ID}x`]) {
    const { ctx } = setup();
    const r = await handleExplain(body({ install_id }), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_install_id");
  }
});

test("an upper-case UUID is accepted", async () => {
  const { ctx } = setup();
  assert.equal((await handleExplain(body({ install_id: ID.toUpperCase() }), ctx)).status, 200);
});

test("upper and lower case share one install counter", async () => {
  const { db, ctx } = setup();
  await handleExplain(body({ install_id: ID.toUpperCase() }), ctx);
  await handleExplain(body({ text: "別", install_id: ID }), ctx);
  assert.equal(await db.countInstall(DAY, ID), 2);
});

test("a wrong or missing prompt_version is 400 bad_request", async () => {
  for (const prompt_version of [2, 0, "1", undefined]) {
    const { ctx, calls } = setup();
    const r = await handleExplain(body({ prompt_version }), ctx);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_request");
    assert.equal(calls.length, 0);
  }
});

test("a body that is not an object is 400 bad_request", async () => {
  for (const b of [null, "x", [], 3]) {
    const { ctx } = setup();
    const r = await handleExplain(b, ctx);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_request");
  }
});

test("success: 200, parsed result, paid call counted, spend added, result cached", async () => {
  const { db, calls, ctx } = setup();
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { result: PARSED });
  assert.equal(r.headers["X-Free-Remaining"], "99");
  assert.deepEqual(calls, ["こんにちは"]);
  assert.equal(await db.countInstall(DAY, ID), 1);
  assert.equal(await db.countIp(DAY, "iphash"), 1);
  assert.ok(Math.abs((await db.getSpend(MONTH)) - COST) < 1e-12);
  assert.deepEqual(await db.getCache(await explanationKey("こんにちは")), PARSED);
});

test("the text sent to the LLM is trimmed", async () => {
  const { calls, ctx } = setup();
  await handleExplain(body({ text: "  こんにちは \n" }), ctx);
  assert.deepEqual(calls, ["こんにちは"]);
});

test("a cache hit returns 200 with no LLM call and untouched counters", async () => {
  const { db, calls, ctx } = setup();
  await db.putCache(await explanationKey("こんにちは"), "こんにちは", PARSED);
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { result: PARSED });
  assert.equal(calls.length, 0);
  assert.equal(await db.countInstall(DAY, ID), 0);
  assert.equal(await db.countIp(DAY, "iphash"), 0);
  assert.equal(await db.getSpend(MONTH), 0);
  assert.equal(r.headers["X-Free-Remaining"], "100");
});

test("a cache hit reports the remaining quota without spending it", async () => {
  const { db, ctx } = setup();
  await handleExplain(body({ text: "a" }), ctx);
  await handleExplain(body({ text: "b" }), ctx);
  const r = await handleExplain(body({ text: "a" }), ctx);
  assert.equal(r.headers["X-Free-Remaining"], "98");
  assert.equal(await db.countInstall(DAY, ID), 2);
});

test("the second install asking for the same text is a cache hit", async () => {
  const { calls, ctx } = setup();
  await handleExplain(body(), ctx);
  const r = await handleExplain(body({ install_id: ID2 }), ctx);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(r.headers["X-Free-Remaining"], "100");
});

test("a cache hit still works over the daily limit and the monthly cap", async () => {
  const { db, calls, ctx } = setup();
  await db.putCache(await explanationKey("こんにちは"), "こんにちは", PARSED);
  db.installs.set(`${DAY}|${ID}`, 100);
  db.spend.set(MONTH, 50);
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.headers["X-Free-Remaining"], "0");
  assert.equal(calls.length, 0);
});

test("100 paid calls pass, the 101st is 429 free_daily_limit", async () => {
  const { calls, ctx } = setup();
  let last;
  for (let i = 0; i < 100; i++) last = await handleExplain(body({ text: `t${i}` }), ctx);
  assert.equal(last.status, 200);
  assert.equal(last.headers["X-Free-Remaining"], "0");
  const r = await handleExplain(body({ text: "t100" }), ctx);
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "free_daily_limit" });
  assert.equal(calls.length, 100);
});

test("the install quota resets on the next UTC day", async () => {
  const { db, ctx } = setup();
  db.installs.set(`${DAY}|${ID}`, 100);
  const r = await handleExplain(body(), { ...ctx, now: new Date("2026-11-02T00:00:01Z") });
  assert.equal(r.status, 200);
  assert.equal(r.headers["X-Free-Remaining"], "99");
});

test("an IP at 300 calls is 429 free_daily_limit even for a fresh install", async () => {
  const { db, calls, ctx } = setup();
  db.ips.set(`${DAY}|iphash`, 300);
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "free_daily_limit");
  assert.equal(calls.length, 0);
});

test("299 calls from an IP still pass", async () => {
  const { db, ctx } = setup();
  db.ips.set(`${DAY}|iphash`, 299);
  assert.equal((await handleExplain(body(), ctx)).status, 200);
});

test("spend at the cap is 429 free_monthly_cap and the LLM is not called", async () => {
  const { db, calls, ctx } = setup();
  db.spend.set(MONTH, 10);
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "free_monthly_cap" });
  assert.equal(calls.length, 0);
});

test("spend from a previous month does not count", async () => {
  const { db, ctx } = setup();
  db.spend.set("2026-10", 99);
  assert.equal((await handleExplain(body(), ctx)).status, 200);
});

test("an LLM failure is 502 free_unavailable with nothing cached or counted", async () => {
  const { db, ctx } = setup({
    callLlm: async () => {
      throw new Error("boom");
    },
  });
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 502);
  assert.deepEqual(r.json, { error: "free_unavailable" });
  assert.equal(db.cache.size, 0);
  assert.equal(db.installs.size, 0);
  assert.equal(db.ips.size, 0);
  assert.equal(db.spend.size, 0);
});

test("an unparseable LLM answer is 502 free_unavailable with nothing cached or counted against quotas", async () => {
  // Its spend is charged (see the "paid but unparseable" test): the call was billed.
  const { db, ctx } = setup({ callLlm: async () => ({ result: CUT, usage: USAGE, finishReason: "length" }) });
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "free_unavailable");
  assert.equal(db.cache.size, 0);
  assert.equal(db.installs.size, 0);
});

test("a disallowed Origin is 403 and nothing runs", async () => {
  const { db, calls, ctx } = setup();
  const r = await handleExplain(body(), { ...ctx, origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(db.installs.size, 0);
});

test("a missing Origin is 403 unless ALLOW_NO_ORIGIN is 1", async () => {
  const denied = setup({ origin: null });
  assert.equal((await handleExplain(body(), denied.ctx)).status, 403);
  const allowed = setup({ origin: null, config: { ...CONFIG, ALLOW_NO_ORIGIN: "1" } });
  assert.equal((await handleExplain(body(), allowed.ctx)).status, 200);
});

test("ALLOWED_ORIGINS takes a comma-separated list of exact origins", async () => {
  const config = { ...CONFIG, ALLOWED_ORIGINS: "chrome-extension://aaa, chrome-extension://bbb" };
  assert.equal((await handleExplain(body(), setup({ config, origin: "chrome-extension://bbb" }).ctx)).status, 200);
  assert.equal((await handleExplain(body(), setup({ config, origin: "chrome-extension://ccc" }).ctx)).status, 403);
  assert.equal((await handleExplain(body(), setup({ config, origin: "https://chrome-extension://aaa" }).ctx)).status, 403);
});

test("the wildcard chrome-extension://* does not match web origins", async () => {
  assert.equal((await handleExplain(body(), setup({ origin: "https://example.com" }).ctx)).status, 403);
});

test("crossing 80% of the monthly cap logs the alert once; staying under or already over does not", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const { db, ctx, pending } = setup();
    db.spend.set(MONTH, 7.99);
    await handleExplain(body({ text: "a" }), { ...ctx, config: { ...CONFIG, PRICE_OUT: 0.001 } }); // +0.03 -> 8.02
    await Promise.all(pending);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments.join(" "), /80% of the monthly budget used \(8\.02 of 10 USD, 2026-11\)/);
    await handleExplain(body({ text: "b" }), { ...ctx, config: { ...CONFIG, PRICE_OUT: 0.001 } }); // already over
    await Promise.all(pending);
    assert.equal(warn.mock.callCount(), 1);
    const fresh = setup();
    await handleExplain(body(), fresh.ctx);
    await Promise.all(fresh.pending);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    warn.mock.restore();
  }
});

test("parseConfig reads string vars into numbers", () => {
  const c = parseConfig({
    DAILY_PER_INSTALL: "100", DAILY_PER_IP: "300", MONTHLY_CAP_USD: "10",
    PRICE_IN_HIT: "6e-9", PRICE_IN_MISS: "3e-7", PRICE_OUT: "1.2e-6",
    ALLOWED_ORIGINS: "chrome-extension://*", ALLOW_NO_ORIGIN: "0",
  });
  assert.equal(c.DAILY_PER_INSTALL, 100);
  assert.equal(c.MONTHLY_CAP_USD, 10);
  assert.equal(c.PRICE_IN_HIT, 6e-9);
  assert.equal(c.ALLOW_NO_ORIGIN, "0");
});

test("parseConfig throws on a missing or non-numeric number var", () => {
  assert.throws(() => parseConfig({ DAILY_PER_INSTALL: "x" }));
});

const estimateCost = (text) =>
  700 * CONFIG.PRICE_OUT + (Array.from(SYSTEM_PROMPT).length + Array.from(text).length) * CONFIG.PRICE_IN_MISS;

test("missing usage on a success charges the conservative estimate", async () => {
  const { db, ctx } = setup({ callLlm: async () => ({ result: RAW }) });
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 200);
  assert.ok(Math.abs((await db.getSpend(MONTH)) - estimateCost("こんにちは")) < 1e-12);
});

test("garbage usage (non-numeric, negative, wrong type) charges the estimate", async () => {
  for (const usage of [null, "x", [], {}, { completion_tokens: "many" }, { prompt_cache_hit_tokens: -5, prompt_cache_miss_tokens: NaN, completion_tokens: -1 }]) {
    const { db, ctx } = setup({ callLlm: async () => ({ result: RAW, usage }) });
    await handleExplain(body(), ctx);
    assert.ok(Math.abs((await db.getSpend(MONTH)) - estimateCost("こんにちは")) < 1e-12, JSON.stringify(usage));
  }
});

test("usage with only the output count charges the estimate for the input side", async () => {
  const { db, ctx } = setup({ callLlm: async () => ({ result: RAW, usage: { completion_tokens: 30 } }) });
  await handleExplain(body(), ctx);
  const want = 30 * CONFIG.PRICE_OUT + (Array.from(SYSTEM_PROMPT).length + 5) * CONFIG.PRICE_IN_MISS;
  assert.ok(Math.abs((await db.getSpend(MONTH)) - want) < 1e-12);
});

test("a paid but unparseable answer adds its spend, but no quota and no cache, and is 502", async () => {
  const { db, ctx } = setup({ callLlm: async () => ({ result: CUT, usage: USAGE, finishReason: "length" }) });
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "free_unavailable");
  assert.ok(Math.abs((await db.getSpend(MONTH)) - COST) < 1e-12);
  assert.equal(db.cache.size, 0);
  assert.equal(db.installs.size, 0);
  assert.equal(db.ips.has(`${DAY}|iphash`), false); // the normal per-IP counter; the failed-call counter is tested below
});

test("a paid unparseable answer without usage is charged the estimate", async () => {
  const { db, ctx } = setup({ callLlm: async () => ({ result: CUT, finishReason: "length" }) });
  assert.equal((await handleExplain(body(), ctx)).status, 502);
  assert.ok(Math.abs((await db.getSpend(MONTH)) - estimateCost("こんにちは")) < 1e-12);
});

test("a callLlm failure flagged as paid (HTTP 200, unreadable payload) is charged and still 502", async () => {
  const { db, ctx } = setup({
    callLlm: async () => {
      throw Object.assign(new Error("bad payload"), { paid: true, usage: USAGE });
    },
  });
  assert.equal((await handleExplain(body(), ctx)).status, 502);
  assert.ok(Math.abs((await db.getSpend(MONTH)) - COST) < 1e-12);
  assert.equal(db.installs.size, 0);
});

test("a paid unparseable answer that crosses 80% of the cap still alerts", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const { db, ctx, pending } = setup({ callLlm: async () => ({ result: CUT, usage: USAGE, finishReason: "length" }) });
    db.spend.set(MONTH, 7.99);
    await handleExplain(body(), { ...ctx, config: { ...CONFIG, PRICE_OUT: 0.001 } });
    await Promise.all(pending);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    warn.mock.restore();
  }
});

test("after a paid call spend (month, then day) is written first, then cache, then the counters", async () => {
  const { db, ctx } = setup();
  const order = [];
  for (const name of ["addSpend", "addDaySpend", "putCache", "incInstall", "incIp"]) {
    const f = db[name];
    db[name] = async (...a) => (order.push(name), f(...a));
  }
  await handleExplain(body(), ctx);
  assert.deepEqual(order, ["addSpend", "addDaySpend", "putCache", "incInstall", "incIp"]);
});

test("a putCache failure still leaves the spend recorded", async () => {
  const { db, ctx } = setup();
  db.putCache = async () => {
    throw new Error("d1 down");
  };
  await assert.rejects(handleExplain(body(), ctx));
  assert.ok(Math.abs((await db.getSpend(MONTH)) - COST) < 1e-12);
});

test("only the exact chrome-extension://* entry is a wildcard; other trailing * are literal", () => {
  const cfg = (ALLOWED_ORIGINS) => ({ ...CONFIG, ALLOWED_ORIGINS });
  assert.equal(originAllowed("https://foo.evil.com", cfg("https://foo*")), false);
  assert.equal(originAllowed("https://foo*", cfg("https://foo*")), true);
  assert.equal(originAllowed("chrome-extension://abc", cfg("chrome-extension://*")), true);
  assert.equal(originAllowed("chrome-extension://abc", cfg("chrome-ext*")), false);
  assert.equal(originAllowed("chrome-extension://abc", cfg("chrome-extension://abc*")), false);
});

test("an LLM failure logs a short cause and nothing secret", async () => {
  const text = "ひみつのテキスト";
  const { ctx } = setup({
    ipHash: "iphash-secret",
    callLlm: async () => {
      throw Object.assign(new Error(`failed for sk-SECRETKEY text=${text} ip=203.0.113.9 iphash-secret ${ID}`), { status: 500 });
    },
  });
  assert.equal((await handleExplain(body({ text }), ctx)).status, 502);
  assert.ok(errors.mock.callCount() >= 1);
  const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  for (const secret of ["SECRETKEY", text, "203.0.113.9", "iphash-secret", ID]) assert.ok(!logged.includes(secret), secret);
  assert.match(logged, /Error/);
  assert.match(logged, /500/);
});

// ---- the model declined the line ----

test("prose instead of JSON is 422 explanation_refused: spend charged, no quota, nothing cached", async () => {
  const { db, ctx } = setup({ callLlm: async () => ({ result: "I can't help with that.", usage: USAGE, finishReason: "stop" }) });
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 422);
  assert.deepEqual(r.json, { error: "explanation_refused" });
  assert.ok(Math.abs((await db.getSpend(MONTH)) - COST) < 1e-12);
  assert.equal(db.cache.size, 0);
  assert.equal(db.installs.size, 0);
  assert.equal(db.ips.has(`${DAY}|iphash`), false); // the normal per-IP counter; the refusal counter is tested below
});

test("finish_reason content_filter is 422 explanation_refused even with empty content", async () => {
  const { ctx } = setup({ callLlm: async () => ({ result: "", usage: USAGE, finishReason: "content_filter" }) });
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "explanation_refused");
});

test("a cut, empty or fenced answer stays 502 free_unavailable", async () => {
  for (const out of [
    { result: CUT, finishReason: "length" },
    { result: "", finishReason: "stop" },
    { result: "```json\n{}\n```", finishReason: "stop" },
  ]) {
    const { ctx } = setup({ callLlm: async () => ({ ...out, usage: USAGE }) });
    const r = await handleExplain(body(), ctx);
    assert.equal(r.status, 502, JSON.stringify(out));
    assert.equal(r.json.error, "free_unavailable");
  }
});

test("a refusal is logged by kind, without the model's text", async () => {
  const { ctx } = setup({ callLlm: async () => ({ result: "SECRET-PROSE", usage: USAGE, finishReason: "stop" }) });
  await handleExplain(body({ text: "SECRET-LINE" }), ctx);
  const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(logged, /refused/);
  assert.doesNotMatch(logged, /SECRET/);
});

// ---- refusals are paid calls: a per-IP daily ceiling ----

const REFUSE = async () => ({ result: "I can't help with that.", usage: USAGE, finishReason: "stop" });
const FAILED_KEY = `${DAY}|failed:iphash`;

test("a refusal counts against the IP's failed-call counter only: not the normal IP counter, not the install", async () => {
  const { db, ctx } = setup({ callLlm: REFUSE });
  assert.equal((await handleExplain(body(), ctx)).status, 422);
  assert.equal(db.ips.get(FAILED_KEY), 1);
  assert.equal(db.ips.size, 1);
  assert.equal(db.installs.size, 0);
  assert.equal(db.cache.size, 0);
});

test("the 21st refusal from one IP in a day is 429 free_daily_limit, and the LLM is not called", async () => {
  const { db, calls, ctx } = setup();
  const refusing = { ...ctx, callLlm: async (t) => (calls.push(t), REFUSE()) };
  for (let i = 0; i < 20; i++) assert.equal((await handleExplain(body(), refusing)).status, 422, `request ${i + 1}`);
  assert.equal(calls.length, 20);
  const spent = await db.getSpend(MONTH);
  const r = await handleExplain(body(), refusing);
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "free_daily_limit" });
  assert.equal(calls.length, 20);
  assert.equal(await db.getSpend(MONTH), spent);
  assert.equal(db.ips.get(FAILED_KEY), 20);
});

test("the refusal ceiling is DAILY_FAILED_PER_IP", async () => {
  const { calls, ctx } = setup();
  const refusing = { ...ctx, config: { ...CONFIG, DAILY_FAILED_PER_IP: 2 }, callLlm: async (t) => (calls.push(t), REFUSE()) };
  assert.equal((await handleExplain(body(), refusing)).status, 422);
  assert.equal((await handleExplain(body(), refusing)).status, 422);
  assert.equal((await handleExplain(body(), refusing)).status, 429);
  assert.equal(calls.length, 2);
});

test("a blocked IP blocks any line and any install, but another IP is unaffected", async () => {
  const { db, calls, ctx } = setup();
  db.ips.set(FAILED_KEY, 20);
  const r = await handleExplain(body({ install_id: ID2, text: "さようなら" }), ctx);
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "free_daily_limit");
  assert.equal(calls.length, 0);
  const other = await handleExplain(body(), { ...ctx, ipHash: "other-iphash" });
  assert.equal(other.status, 200);
  assert.equal(calls.length, 1);
});

test("the refusal counter resets on the next UTC day", async () => {
  const { db, ctx } = setup();
  db.ips.set(FAILED_KEY, 20);
  const r = await handleExplain(body(), { ...ctx, now: new Date("2026-11-02T00:00:01Z") });
  assert.equal(r.status, 200);
});

test("successful explanations do not touch the refusal counter", async () => {
  const { db, ctx } = setup();
  for (const text of ["いち", "に", "さん"]) assert.equal((await handleExplain(body({ text }), ctx)).status, 200);
  assert.deepEqual([...db.ips.keys()], [`${DAY}|iphash`]);
  assert.equal(db.ips.get(`${DAY}|iphash`), 3);
});

test("a rejected (non-refusal) answer is a paid call without an explanation: it is counted too, and stays 502", async () => {
  for (const out of [
    { result: CUT, finishReason: "length" },
    { result: "{not valid json}", finishReason: "stop" }, // malformed JSON
    { result: JSON.stringify({ notes: [], suggestions: [] }), finishReason: "stop" }, // JSON without translation
  ]) {
    const { db, ctx } = setup({ callLlm: async () => ({ ...out, usage: USAGE }) });
    const r = await handleExplain(body(), ctx);
    assert.equal(r.status, 502, JSON.stringify(out));
    assert.equal(r.json.error, "free_unavailable");
    assert.deepEqual([...db.ips], [[FAILED_KEY, 1]], JSON.stringify(out));
    assert.equal(db.installs.size, 0);
  }
});

test("a paid call whose body was unreadable (HTTP 200, e.paid) is counted too, and stays 502", async () => {
  const { db, ctx } = setup({
    callLlm: async () => {
      throw Object.assign(new Error("bad payload"), { paid: true, usage: USAGE });
    },
  });
  assert.equal((await handleExplain(body(), ctx)).status, 502);
  assert.deepEqual([...db.ips], [[FAILED_KEY, 1]]);
});

test("a provider failure where nothing was paid (network error, non-200) is not counted", async () => {
  for (const e of [new Error("network down"), Object.assign(new Error("DeepSeek HTTP error"), { status: 500 })]) {
    const { db, ctx } = setup({
      callLlm: async () => {
        throw e;
      },
    });
    assert.equal((await handleExplain(body(), ctx)).status, 502);
    assert.equal(db.ips.size, 0);
    assert.equal(await db.getSpend(MONTH), 0);
  }
});

test("failed paid calls of every kind share one ceiling", async () => {
  const { db, calls, ctx } = setup();
  const outs = [REFUSE, async () => ({ result: CUT, usage: USAGE, finishReason: "length" }), async () => { throw Object.assign(new Error("x"), { paid: true }); }];
  let n = 0;
  const mixed = { ...ctx, config: { ...CONFIG, DAILY_FAILED_PER_IP: 3 }, callLlm: async (t) => (calls.push(t), outs[n++ % 3]()) };
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await handleExplain(body(), mixed)).status);
  assert.deepEqual(statuses, [422, 502, 502]);
  assert.equal((await handleExplain(body(), mixed)).status, 429);
  assert.equal(calls.length, 3);
  assert.equal(db.ips.get(FAILED_KEY), 3);
});

test("a cached line is still served to an IP at its refusal ceiling", async () => {
  const { db, calls, ctx } = setup();
  assert.equal((await handleExplain(body(), ctx)).status, 200);
  db.ips.set(FAILED_KEY, 20);
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { result: PARSED });
  assert.equal(calls.length, 1);
});

test("the refusal log carries neither the line nor the IP hash", async () => {
  const { ctx } = setup({ ipHash: "iphash-secret", callLlm: REFUSE });
  await handleExplain(body({ text: "SECRET-LINE" }), ctx);
  const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(logged, /refused/);
  assert.doesNotMatch(logged, /SECRET-LINE|iphash-secret/);
});

test("parseConfig: DAILY_FAILED_PER_IP is read like the other limits and defaults to 20", () => {
  const env = {
    DAILY_PER_INSTALL: "100", DAILY_PER_IP: "300", MONTHLY_CAP_USD: "10",
    PRICE_IN_HIT: "6e-9", PRICE_IN_MISS: "3e-7", PRICE_OUT: "1.2e-6",
  };
  assert.equal(parseConfig(env).DAILY_FAILED_PER_IP, 20);
  assert.equal(parseConfig({ ...env, DAILY_FAILED_PER_IP: "5" }).DAILY_FAILED_PER_IP, 5);
  assert.throws(() => parseConfig({ ...env, DAILY_FAILED_PER_IP: "lots" }));
});

// ---- spend alerts ----
// A paid call that costs exactly `usd`: PRICE_OUT 1 and no input tokens.
const paying = (usd) => ({ callLlm: async () => ({ result: RAW, usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens: usd } }) });
const ONE_USD_OUT = { ...CONFIG, PRICE_OUT: 1 };
const alerting = (over = {}) => {
  const sent = [];
  const out = setup({ notify: async (t) => void sent.push(t), config: ONE_USD_OUT, ...over });
  return { ...out, sent };
};
const logs = (m) => m.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
const warns = () => mock.method(console, "warn", () => {});

test("parseConfig: DAILY_ALERT_USD defaults to a quarter of the monthly cap, can be set, and bad values throw", () => {
  const env = {
    DAILY_PER_INSTALL: "100", DAILY_PER_IP: "300", MONTHLY_CAP_USD: "10",
    PRICE_IN_HIT: "6e-9", PRICE_IN_MISS: "3e-7", PRICE_OUT: "1.2e-6",
  };
  assert.equal(parseConfig(env).DAILY_ALERT_USD, 2.5);
  assert.equal(parseConfig({ ...env, DAILY_ALERT_USD: "" }).DAILY_ALERT_USD, 2.5);
  assert.equal(parseConfig({ ...env, MONTHLY_CAP_USD: "20" }).DAILY_ALERT_USD, 5);
  assert.equal(parseConfig({ ...env, DAILY_ALERT_USD: "1.5" }).DAILY_ALERT_USD, 1.5);
  assert.throws(() => parseConfig({ ...env, DAILY_ALERT_USD: "lots" }), /bad config var DAILY_ALERT_USD/);
});

test("an alert is sent once per threshold per month: sequential charges past 80%", async () => {
  const w = warns();
  try {
    const { db, ctx, pending, sent } = alerting();
    db.spend.set(MONTH, 7.5);
    await handleExplain(body({ text: "a" }), { ...ctx, ...paying(0.4) }); // 7.9: nothing
    await handleExplain(body({ text: "b" }), { ...ctx, ...paying(0.4) }); // 8.3: 80%
    await handleExplain(body({ text: "c" }), { ...ctx, ...paying(0.4) }); // 8.7: already sent
    await Promise.all(pending);
    assert.deepEqual(sent, ["anki-manga free tier: 80% of the monthly budget used (8.3 of 10 USD, 2026-11)."]);
  } finally {
    w.mock.restore();
  }
});

test("concurrent charges crossing 80% send one alert", async () => {
  const w = warns();
  try {
    const { db, ctx, pending, sent } = alerting();
    db.spend.set(MONTH, 7.5);
    const rs = await Promise.all([
      handleExplain(body({ text: "a" }), { ...ctx, ...paying(0.4) }),
      handleExplain(body({ text: "b" }), { ...ctx, ...paying(0.4) }),
      handleExplain(body({ text: "c" }), { ...ctx, ...paying(0.4) }),
    ]);
    await Promise.all(pending);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(sent.length, 1);
  } finally {
    w.mock.restore();
  }
});

test("one charge that crosses 80% and 100% sends both alerts, 80% first", async () => {
  const w = warns();
  try {
    const { db, ctx, pending, sent } = alerting({ config: { ...ONE_USD_OUT, DAILY_ALERT_USD: 100 } });
    db.spend.set(MONTH, 7.9);
    await handleExplain(body(), { ...ctx, ...paying(2.5) });
    await Promise.all(pending);
    assert.equal(sent.length, 2);
    assert.match(sent[0], /80% of the monthly budget used \(10\.4 of 10 USD, 2026-11\)/);
    assert.match(sent[1], /100% of the monthly budget used .* off until 2026-12-01 \(UTC\)/);
    // and neither again
    await handleExplain(body({ text: "b" }), { ...ctx, config: { ...ONE_USD_OUT, MONTHLY_CAP_USD: 100, DAILY_ALERT_USD: 100 }, ...paying(0.1) });
    await Promise.all(pending);
    assert.equal(sent.length, 2);
  } finally {
    w.mock.restore();
  }
});

test("the 100% alert fires when the charge that reaches the cap is the one after 80%", async () => {
  const w = warns();
  try {
    const { db, ctx, pending, sent } = alerting({ config: { ...ONE_USD_OUT, DAILY_ALERT_USD: 100 } });
    db.spend.set(MONTH, 8.5);
    await handleExplain(body({ text: "a" }), { ...ctx, ...paying(1) }); // 9.5: nothing, 80% was passed earlier
    await handleExplain(body({ text: "b" }), { ...ctx, ...paying(1) }); // 10.5
    await Promise.all(pending);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^anki-manga free tier: 100%/);
  } finally {
    w.mock.restore();
  }
});

test("the next month alerts again", async () => {
  const w = warns();
  try {
    const { db, ctx, pending, sent } = alerting();
    db.spend.set("2026-11", 7.9);
    db.spend.set("2026-12", 7.9);
    await handleExplain(body({ text: "a" }), { ...ctx, ...paying(0.5) });
    await handleExplain(body({ text: "b" }), { ...ctx, now: new Date("2026-12-01T00:00:01Z"), ...paying(0.5) });
    await Promise.all(pending);
    assert.equal(sent.length, 2);
    assert.match(sent[0], /2026-11/);
    assert.match(sent[1], /2026-12/);
  } finally {
    w.mock.restore();
  }
});

test("a daily spend spike alerts once a day, and again the next day", async () => {
  const w = warns();
  try {
    const { ctx, pending, sent } = alerting();
    await handleExplain(body({ text: "a" }), { ...ctx, ...paying(2.4) }); // below 2.5
    await handleExplain(body({ text: "b" }), { ...ctx, ...paying(0.2) }); // 2.6: spike
    await handleExplain(body({ text: "c" }), { ...ctx, ...paying(0.2) }); // already sent
    await handleExplain(body({ text: "d" }), { ...ctx, now: new Date("2026-11-02T00:00:00Z"), ...paying(2.6) });
    await Promise.all(pending);
    assert.deepEqual(sent, [
      "anki-manga free tier: unusual daily spend: 2.6 USD on 2026-11-01 (alert threshold 2.5 USD).",
      "anki-manga free tier: unusual daily spend: 2.6 USD on 2026-11-02 (alert threshold 2.5 USD).",
    ]);
  } finally {
    w.mock.restore();
  }
});

test("the daily threshold is DAILY_ALERT_USD", async () => {
  const w = warns();
  try {
    const { ctx, pending, sent } = alerting({ config: { ...ONE_USD_OUT, DAILY_ALERT_USD: 1 } });
    await handleExplain(body({ text: "a" }), { ...ctx, ...paying(1.2) });
    await Promise.all(pending);
    assert.match(sent[0], /1\.2 USD on 2026-11-01 \(alert threshold 1 USD\)/);
  } finally {
    w.mock.restore();
  }
});

test("a failing notify is logged without secrets, the claim is released, and the answer is unaffected", async () => {
  const w = warns();
  try {
    const notify = async () => {
      throw Object.assign(new Error("fetch failed: https://api.telegram.org/bot123:SECRET/sendMessage"), { status: 502 });
    };
    const { db, ctx, pending } = alerting({ notify });
    db.spend.set(MONTH, 7.9);
    const r = await handleExplain(body(), { ...ctx, ...paying(0.5) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.result, PARSED);
    await Promise.all(pending);
    assert.equal(db.alerts.has(`${MONTH}|month_80`), false, "released so the cron can retry");
    const logged = logs(errors);
    assert.match(logged, /alert failed/);
    assert.ok(!logged.includes("SECRET") && !logged.includes("telegram.org"), logged);
  } finally {
    w.mock.restore();
  }
});

test("without a notifier the alert is claimed and logged, and nothing throws", async () => {
  const w = warns();
  try {
    const { db, ctx, pending } = setup({ config: ONE_USD_OUT, notify: null });
    db.spend.set(MONTH, 7.9);
    const r = await handleExplain(body({ text: "SECRET-LINE" }), { ...ctx, ...paying(0.5) });
    await Promise.all(pending);
    assert.equal(r.status, 200);
    assert.equal(db.alerts.has(`${MONTH}|month_80`), true);
    assert.equal(w.mock.callCount(), 1);
    const logged = logs(w);
    assert.match(logged, /80% of the monthly budget used/);
    assert.doesNotMatch(logged, /SECRET-LINE|iphash|3b241101/);
  } finally {
    w.mock.restore();
  }
});

test("the alert work goes to waitUntil and the response does not wait for a slow notify", async () => {
  const w = warns();
  try {
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    const started = [];
    const { db, ctx, pending } = alerting({ notify: async (t) => (started.push(t), slow) });
    db.spend.set(MONTH, 7.9);
    const r = await handleExplain(body(), { ...ctx, ...paying(0.5) });
    assert.equal(r.status, 200);
    assert.equal(pending.length, 1, "one promise for all the alert work");
    let settled = false;
    pending[0].then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started.length, 1);
    assert.equal(settled, false, "still waiting for the notifier");
    release();
    await pending[0];
    assert.equal(settled, true);
  } finally {
    w.mock.restore();
  }
});

test("no alert work is scheduled when no threshold was crossed", async () => {
  const { ctx, pending } = alerting();
  await handleExplain(body(), { ...ctx, ...paying(0.1) });
  assert.equal(pending.length, 0);
});

test("the alert promise never rejects, even when the bookkeeping fails", async () => {
  const { db, ctx, pending, sent } = alerting();
  db.spend.set(MONTH, 7.9);
  db.claimAlert = async () => {
    throw new Error("d1 down SECRET-SQL");
  };
  const r = await handleExplain(body(), { ...ctx, ...paying(0.5) });
  assert.equal(r.status, 200);
  await Promise.all(pending);
  assert.equal(sent.length, 0);
  assert.doesNotMatch(logs(errors), /SECRET-SQL/);
});

test("the spend is charged before any alert work starts", async () => {
  const w = warns();
  try {
    const { db, ctx } = alerting();
    db.spend.set(MONTH, 7.9);
    const order = [];
    for (const name of ["addSpend", "addDaySpend", "claimAlert"]) {
      const f = db[name];
      db[name] = async (...a) => (order.push(name), f(...a));
    }
    await handleExplain(body(), { ...ctx, ...paying(0.5) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(order, ["addSpend", "addDaySpend", "claimAlert"]);
  } finally {
    w.mock.restore();
  }
});

test("a failing daily-spend write does not fail the request or lose the monthly spend", async () => {
  const { db, ctx } = alerting();
  db.addDaySpend = async () => {
    throw new Error("no such table: spend_days");
  };
  const r = await handleExplain(body(), { ...ctx, ...paying(0.5) });
  assert.equal(r.status, 200);
  assert.equal(await db.getSpend(MONTH), 0.5);
  assert.match(logs(errors), /spend_days|daily spend/);
});

test("an LLM answer that is refused or unusable still charges and can alert", async () => {
  const w = warns();
  try {
    const { db, ctx, pending, sent } = alerting({ config: { ...ONE_USD_OUT, DAILY_ALERT_USD: 100 } });
    db.spend.set(MONTH, 7.9);
    const r = await handleExplain(body(), { ...ctx, callLlm: async () => ({ result: "I can't help with that.", usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens: 0.5 }, finishReason: "stop" }) });
    assert.equal(r.status, 422);
    await Promise.all(pending);
    assert.equal(sent.length, 1);
  } finally {
    w.mock.restore();
  }
});

test("checkMonthAlerts sends the 80% and 100% alerts that were reached, and not the ones already claimed", async () => {
  const w = warns();
  try {
    const db = memoryDb();
    const sent = [];
    const notify = async (t) => void sent.push(t);
    const now = new Date("2026-11-20T03:17:00Z");

    db.spend.set(MONTH, 5);
    await checkMonthAlerts({ db, config: CONFIG, now, notify });
    assert.deepEqual(sent, [], "under 80%");

    db.spend.set(MONTH, 8.5);
    await checkMonthAlerts({ db, config: CONFIG, now, notify });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /80% .*\(8\.5 of 10 USD, 2026-11\)/);
    await checkMonthAlerts({ db, config: CONFIG, now, notify });
    assert.equal(sent.length, 1, "claimed: not sent again");

    db.spend.set(MONTH, 10.2);
    await checkMonthAlerts({ db, config: CONFIG, now, notify });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /^anki-manga free tier: 100%/);
  } finally {
    w.mock.restore();
  }
});

test("checkMonthAlerts re-sends an alert whose earlier send failed, and does not look at the daily spike", async () => {
  const w = warns();
  try {
    const db = memoryDb();
    const now = new Date("2026-11-20T03:17:00Z");
    db.spend.set(MONTH, 8.5);
    db.daySpend.set("2026-11-19", 99);
    await checkMonthAlerts({ db, config: CONFIG, now, notify: async () => { throw Object.assign(new Error("x"), { status: 500 }); } });
    assert.equal(db.alerts.size, 0, "released after the failed send");
    const sent = [];
    await checkMonthAlerts({ db, config: CONFIG, now, notify: async (t) => void sent.push(t) });
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].includes("daily"));
  } finally {
    w.mock.restore();
  }
});

test("checkMonthAlerts without a notifier only claims and logs", async () => {
  const w = warns();
  try {
    const db = memoryDb();
    db.spend.set(MONTH, 10.5);
    await checkMonthAlerts({ db, config: CONFIG, now: NOW, notify: null });
    assert.equal(db.alerts.size, 2);
    assert.equal(w.mock.callCount(), 2);
  } finally {
    w.mock.restore();
  }
});

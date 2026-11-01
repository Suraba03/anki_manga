import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleExplain, parseConfig, explanationKey } from "../src/explain.js";
import { PROMPT_VERSION } from "../../extension/lib/prompt.js";

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID2 = "9f1c2d3e-0000-4000-8000-000000000001";
const ORIGIN = "chrome-extension://abcdefghijklmnop";
const NOW = new Date("2026-11-01T12:00:00Z");
const DAY = "2026-11-01";
const MONTH = "2026-11";

const CONFIG = {
  DAILY_PER_INSTALL: 100,
  DAILY_PER_IP: 300,
  MONTHLY_CAP_USD: 10,
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
const USAGE = { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20, completion_tokens: 30 };
const COST = 10 * CONFIG.PRICE_IN_HIT + 20 * CONFIG.PRICE_IN_MISS + 30 * CONFIG.PRICE_OUT;

function memoryDb() {
  const cache = new Map();
  const installs = new Map();
  const ips = new Map();
  const spend = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  return {
    cache, installs, ips, spend,
    getCache: async (key) => cache.get(key)?.result ?? null,
    putCache: async (key, text, result) => void cache.set(key, { text, result }),
    countInstall: async (day, id) => installs.get(`${day}|${id}`) ?? 0,
    incInstall: async (day, id) => bump(installs, `${day}|${id}`),
    countIp: async (day, h) => ips.get(`${day}|${h}`) ?? 0,
    incIp: async (day, h) => bump(ips, `${day}|${h}`),
    getSpend: async (month) => spend.get(month) ?? 0,
    addSpend: async (month, usd) => void spend.set(month, (spend.get(month) ?? 0) + usd),
  };
}

function setup(over = {}) {
  const db = memoryDb();
  const calls = [];
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
    ...over,
  };
  return { db, calls, ctx };
}

const body = (over = {}) => ({ install_id: ID, text: "こんにちは", prompt_version: PROMPT_VERSION, ...over });
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

test("an unparseable LLM answer is 502 free_unavailable with nothing cached or counted", async () => {
  const { db, ctx } = setup({ callLlm: async () => ({ result: "not json", usage: USAGE }) });
  const r = await handleExplain(body(), ctx);
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "free_unavailable");
  assert.equal(db.cache.size, 0);
  assert.equal(db.installs.size, 0);
  assert.equal(db.spend.size, 0);
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

test("crossing 80% of the monthly cap warns once; staying under or already over does not", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const { db, ctx } = setup();
    db.spend.set(MONTH, 7.99);
    await handleExplain(body({ text: "a" }), { ...ctx, config: { ...CONFIG, PRICE_OUT: 0.001 } }); // +0.03 -> 8.02
    assert.equal(warn.mock.callCount(), 1);
    await handleExplain(body({ text: "b" }), { ...ctx, config: { ...CONFIG, PRICE_OUT: 0.001 } }); // already over
    assert.equal(warn.mock.callCount(), 1);
    const fresh = setup();
    await handleExplain(body(), fresh.ctx);
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

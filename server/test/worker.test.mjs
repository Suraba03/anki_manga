import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { handle, callDeepSeek, makeD1Db } from "../src/worker.js";
import { parseConfig, originAllowed } from "../src/explain.js";
import { readFileSync } from "node:fs";
import { buildMessages } from "../../extension/lib/prompt.js";

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ORIGIN = "chrome-extension://abcdefghijklmnop";
const RAW = JSON.stringify({ translation: "Hello", notes: [], suggestions: [] });

const ENV = {
  DEEPSEEK_API_KEY: "sk-test",
  IP_SALT: "salt",
  DAILY_PER_INSTALL: "100", DAILY_PER_IP: "300", MONTHLY_CAP_USD: "10",
  PRICE_IN_HIT: "0.000001", PRICE_IN_MISS: "0.00001", PRICE_OUT: "0.0001",
  ALLOWED_ORIGINS: "chrome-extension://*",
  ALLOW_NO_ORIGIN: "0",
  DB: {},
};

function memoryDb() {
  const cache = new Map();
  const counts = new Map();
  const spend = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);
  return {
    counts, cache,
    getCache: async (k) => cache.get(k) ?? null,
    putCache: async (k, _t, r) => void cache.set(k, r),
    countInstall: async (d, id) => counts.get(`i|${d}|${id}`) ?? 0,
    incInstall: async (d, id) => bump(`i|${d}|${id}`),
    countIp: async (d, h) => counts.get(`p|${d}|${h}`) ?? 0,
    incIp: async (d, h) => bump(`p|${d}|${h}`),
    getSpend: async (m) => spend.get(m) ?? 0,
    addSpend: async (m, u) => void spend.set(m, (spend.get(m) ?? 0) + u),
  };
}

let errors;
beforeEach(() => {
  errors = mock.method(console, "error", () => {});
});
afterEach(() => errors.mock.restore());

const req = (over = {}, bodyObj) =>
  new Request(over.url ?? "https://w.example/explain", {
    method: over.method ?? "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...over.headers },
    body: over.method === "OPTIONS" || over.method === "GET" ? undefined : JSON.stringify(bodyObj ?? { install_id: ID, text: "こんにちは", prompt_version: 1 }),
  });

const deps = (over = {}) => ({
  db: memoryDb(),
  callLlm: async () => ({ result: RAW, usage: { completion_tokens: 1 } }),
  now: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

test("OPTIONS preflight from an allowed origin is 204 with CORS headers", async () => {
  const r = await handle(req({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } }), ENV, deps());
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(r.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(r.headers.get("Access-Control-Allow-Headers"), /Content-Type/i);
  assert.equal(r.headers.get("Vary"), "Origin");
});

test("OPTIONS preflight from a disallowed origin is 403 without CORS headers", async () => {
  const r = await handle(req({ method: "OPTIONS", headers: { Origin: "https://evil.example" } }), ENV, deps());
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
});

test("a 200 carries CORS, exposes X-Free-Remaining, and returns {result}", async () => {
  const r = await handle(req(), ENV, deps());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(r.headers.get("Access-Control-Expose-Headers"), /X-Free-Remaining/);
  assert.equal(r.headers.get("X-Free-Remaining"), "99");
  assert.equal(r.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await r.json(), { result: { translation: "Hello", notes: [], suggestions: [] } });
});

test("error responses carry the CORS headers too (400, 429, 502)", async () => {
  const bad = await handle(req({}, { install_id: "x", text: "a", prompt_version: 1 }), ENV, deps());
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(bad.headers.get("Access-Control-Expose-Headers"), /X-Free-Remaining/);

  const capped = deps();
  await capped.db.addSpend("2026-11", 11);
  const r429 = await handle(req(), ENV, capped);
  assert.equal(r429.status, 429);
  assert.equal(r429.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const r502 = await handle(req(), ENV, deps({ callLlm: async () => { throw new Error("x"); } }));
  assert.equal(r502.status, 502);
  assert.equal(r502.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.deepEqual(await r502.json(), { error: "free_unavailable" });
});

test("a database failure is 502 free_unavailable, not a thrown error", async () => {
  const db = memoryDb();
  db.getCache = async () => { throw new Error("d1 down"); };
  const r = await handle(req(), ENV, deps({ db }));
  assert.equal(r.status, 502);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("the 403 for a disallowed origin has no Access-Control-Allow-Origin", async () => {
  const r = await handle(req({ headers: { Origin: "https://evil.example" } }), ENV, deps());
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
});

test("a request without Origin is allowed only with ALLOW_NO_ORIGIN=1", async () => {
  const mk = () => new Request("https://w.example/explain", { method: "POST", body: JSON.stringify({ install_id: ID, text: "a", prompt_version: 1 }) });
  assert.equal((await handle(mk(), ENV, deps())).status, 403);
  const r = await handle(mk(), { ...ENV, ALLOW_NO_ORIGIN: "1" }, deps());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
});

test("POST / works like POST /explain; other paths 404; GET is 405", async () => {
  assert.equal((await handle(req({ url: "https://w.example/" }), ENV, deps())).status, 200);
  assert.equal((await handle(req({ url: "https://w.example/other" }), ENV, deps())).status, 404);
  assert.equal((await handle(req({ method: "GET" }), ENV, deps())).status, 405);
});

test("malformed JSON is 400 bad_request", async () => {
  const r = await handle(new Request("https://w.example/explain", { method: "POST", headers: { Origin: ORIGIN }, body: "{nope" }), ENV, deps());
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "bad_request" });
});

test("an oversized body is 400 bad_request", async () => {
  const r = await handle(req({}, { install_id: ID, text: "あ".repeat(20000), prompt_version: 1 }), ENV, deps());
  assert.equal(r.status, 400);
});

test("only a salted hash of the IP reaches the db, never the raw address", async () => {
  const d = deps();
  await handle(req(), ENV, d);
  const want = createHash("sha256").update("salt203.0.113.9").digest("hex");
  assert.ok([...d.db.counts.keys()].includes(`p|2026-11-01|${want}`));
  assert.ok(![...d.db.counts.keys()].some((k) => k.includes("203.0.113.9")));
});

test("missing secrets are a 500 server_misconfigured", async () => {
  const r = await handle(req(), { ...ENV, IP_SALT: "" }, deps());
  assert.equal(r.status, 500);
  assert.equal((await handle(req(), { ...ENV, DEEPSEEK_API_KEY: undefined }, deps())).status, 500);
});

test("default export exposes fetch", () => {
  assert.equal(typeof worker.fetch, "function");
});

test("callDeepSeek sends the same body as the extension's own-key path", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, init };
    return Response.json({
      choices: [{ message: { content: RAW } }],
      usage: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2, completion_tokens: 3, total_tokens: 6 },
    });
  };
  const out = await callDeepSeek("こんにちは", { apiKey: "sk-x", model: "deepseek-flash", fetch });
  assert.equal(seen.url, "https://api.deepseek.com/chat/completions");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer sk-x");
  assert.deepEqual(JSON.parse(seen.init.body), {
    model: "deepseek-flash",
    messages: buildMessages("こんにちは"),
    response_format: { type: "json_object" },
    max_tokens: 700,
    stream: false,
    thinking: { type: "disabled" },
  });
  assert.equal(out.result, RAW);
  assert.equal(out.finishReason, null);
  assert.deepEqual(out.usage, { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2, completion_tokens: 3, total_tokens: 6 });
});

test("callDeepSeek rejects on a non-200, a bad payload and a timeout", async () => {
  await assert.rejects(callDeepSeek("a", { apiKey: "k", model: "m", fetch: async () => new Response("no", { status: 500 }) }));
  await assert.rejects(callDeepSeek("a", { apiKey: "k", model: "m", fetch: async () => Response.json({ choices: [] }) }));
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  await assert.rejects(callDeepSeek("a", { apiKey: "k", model: "m", fetch: hang, timeoutMs: 20 }));
});

test("makeD1Db issues UPSERTs and bound queries against the D1 binding", async () => {
  const log = [];
  const rows = { cache: null, count: null, spend: null };
  const d1 = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (log.push({ sql, args }), /FROM cache/.test(sql) ? rows.cache : /FROM spend/.test(sql) ? rows.spend : rows.count),
        run: async () => void log.push({ sql, args }),
      }),
    }),
  };
  const db = makeD1Db(d1, () => 1700000000000);
  assert.equal(await db.getCache("k"), null);
  rows.cache = { result: JSON.stringify({ translation: "x" }) };
  assert.deepEqual(await db.getCache("k"), { translation: "x" });
  assert.equal(await db.countInstall("2026-11-01", ID), 0);
  rows.count = { n: 4 };
  assert.equal(await db.countInstall("2026-11-01", ID), 4);
  assert.equal(await db.countIp("2026-11-01", "h"), 4);
  assert.equal(await db.getSpend("2026-11"), 0);
  rows.spend = { usd: 1.5 };
  assert.equal(await db.getSpend("2026-11"), 1.5);
  log.length = 0;
  await db.incInstall("2026-11-01", ID);
  await db.incIp("2026-11-01", "h");
  await db.addSpend("2026-11", 0.25);
  await db.putCache("k", "text", { translation: "x" });
  assert.match(log[0].sql, /INSERT INTO install_counts[\s\S]*ON CONFLICT[\s\S]*n = n \+ 1/);
  assert.deepEqual(log[0].args, ["2026-11-01", ID]);
  assert.match(log[1].sql, /INSERT INTO ip_counts[\s\S]*ON CONFLICT[\s\S]*n = n \+ 1/);
  assert.match(log[2].sql, /INSERT INTO spend[\s\S]*ON CONFLICT[\s\S]*usd = usd \+ excluded\.usd/);
  assert.deepEqual(log[2].args, ["2026-11", 0.25]);
  assert.match(log[3].sql, /INSERT OR REPLACE INTO cache/);
  assert.deepEqual(log[3].args, ["k", "text", JSON.stringify({ translation: "x" }), 1700000000000]);
});

test("a DB failure logs a short cause and nothing secret", async () => {
  const db = memoryDb();
  db.getCache = async () => {
    throw new Error("D1_ERROR: SELECT ... こんにちは sk-test 203.0.113.9");
  };
  const r = await handle(req(), ENV, deps({ db }));
  assert.equal(r.status, 502);
  const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.ok(errors.mock.callCount() >= 1);
  for (const secret of ["sk-test", "こんにちは", "203.0.113.9", "salt"]) assert.ok(!logged.includes(secret), secret);
});

test("the model comes from LLM_MODEL and defaults to deepseek-flash", async () => {
  const seen = [];
  const fetch = async (_u, init) => {
    seen.push(JSON.parse(init.body).model);
    return Response.json({ choices: [{ message: { content: RAW } }], usage: { completion_tokens: 1 } });
  };
  const noLlm = () => ({ db: memoryDb(), now: new Date("2026-11-01T00:00:00Z"), fetch });
  await handle(req(), ENV, noLlm());
  await handle(req(), { ...ENV, LLM_MODEL: "other-model" }, noLlm());
  assert.deepEqual(seen, ["deepseek-flash", "other-model"]);
});

test("a 200 from DeepSeek with an unreadable payload is flagged paid; HTTP errors are not", async () => {
  const bad = await callDeepSeek("a", { apiKey: "k", model: "m", fetch: async () => new Response("<html>", { status: 200 }) }).catch((e) => e);
  assert.equal(bad.paid, true);
  const http = await callDeepSeek("a", { apiKey: "k", model: "m", fetch: async () => new Response("no", { status: 500 }) }).catch((e) => e);
  assert.notEqual(http.paid, true);
  assert.equal(http.status, 500);
  const usage = { completion_tokens: 4 };
  const noContent = await callDeepSeek("a", { apiKey: "k", model: "m", fetch: async () => Response.json({ choices: [], usage }) }).catch((e) => e);
  assert.equal(noContent.paid, true);
  assert.deepEqual(noContent.usage, usage);
});

test("wrangler.toml ships deepseek-flash and the deployed D1 database id", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /^LLM_MODEL = "deepseek-flash"$/m);
  // The id is not a secret (useless without the owner's Cloudflare account); it is committed so deploys are reproducible.
  assert.match(toml, /^database_id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/m);
  assert.doesNotMatch(toml, /REPLACE_WITH_D1_ID/);
});

test("callDeepSeek reports finish_reason, for logging a rejected answer", async () => {
  const fetch = async () => Response.json({ choices: [{ message: { content: "   " }, finish_reason: "length" }], usage: {} });
  const out = await callDeepSeek("a", { apiKey: "k", model: "m", fetch });
  assert.equal(out.finishReason, "length");
});

test("callDeepSeek: a content_filter stop with no content is a paid answer with empty text, not an error", async () => {
  const usage = { completion_tokens: 0 };
  const fetch = async () => Response.json({ choices: [{ message: { content: null }, finish_reason: "content_filter" }], usage });
  const out = await callDeepSeek("a", { apiKey: "k", model: "m", fetch });
  assert.deepEqual(out, { result: "", usage, finishReason: "content_filter" });
});

test("a refused line reaches the extension as 422 explanation_refused with CORS", async () => {
  const res = await handle(req(), ENV, deps({ callLlm: async () => ({ result: "I can't help with that.", usage: {}, finishReason: "stop" }) }));
  assert.equal(res.status, 422);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.deepEqual(await res.json(), { error: "explanation_refused" });
});

const STORE_ORIGIN = "chrome-extension://bgfnpifeeclmpfdcahphaiahgafjppeo";

test("wrangler.toml allows exactly the Web Store extension, no wildcard", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const value = toml.match(/^ALLOWED_ORIGINS = "([^"]*)"$/m)[1];
  const list = value.split(",").map((s) => s.trim());
  assert.ok(list.includes(STORE_ORIGIN));
  assert.ok(list.every((o) => /^chrome-extension:\/\/[a-p]{32}$/.test(o)), `exact extension origins only: ${value}`);
  const config = parseConfig({ ...ENV, ALLOWED_ORIGINS: value });
  assert.equal(originAllowed(STORE_ORIGIN, config), true);
  assert.equal(originAllowed("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", config), false);
  assert.equal(originAllowed("https://example.com", config), false);
});

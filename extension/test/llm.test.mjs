import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, PROMPT_VERSION, buildMessages, parseExplanation } from "../lib/prompt.js";
import { explain, FREE_URL } from "../lib/llm.js";

const GOOD = {
  translation: "You can tell just by looking",
  notes: [{ focus: "見りゃ", explanation: "contraction of 見れば" }],
  suggestions: [{ word: "見る", reading: "みる", meaning: "to see" }],
};
const TEXT = "見りゃ分かるだろ";
const FREE_URL_TEST = "https://free.example.test/explain";

const jsonResponse = (status, payload, headers = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...headers } });
const chatPayload = (obj = GOOD) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    explanationKey: async (t) => `key:${t.normalize("NFKC").trim()}`,
    getExplanation: async (k) => data.get(k) ?? null,
    putExplanation: async (k, v) => void data.set(k, v),
  };
}
const own = (extra = {}) => ({ installId: "inst-1", llm: { mode: "own", provider: "deepseek", apiKey: "sk-ok", baseUrl: "", model: "", ...extra } });
const free = () => ({ installId: "inst-1", llm: { mode: "free", provider: "deepseek", apiKey: "", baseUrl: "", model: "" } });
const run = (text, settings, fetch, store = fakeStore(), freeUrl = FREE_URL_TEST) => explain(text, { settings, store, fetch, freeUrl });

// ---- prompt (port of test_request_shape / parse tests) ----

test("request shape: fixed system prompt first, user text second", () => {
  const m = buildMessages(TEXT);
  assert.deepEqual(m[0], { role: "system", content: SYSTEM_PROMPT });
  assert.deepEqual(m[1], { role: "user", content: TEXT });
  assert.deepEqual(buildMessages("a")[0], buildMessages("b")[0]);
  assert.ok(SYSTEM_PROMPT.includes("JSON"));
  assert.equal(PROMPT_VERSION, 1);
  assert.ok(SYSTEM_PROMPT.startsWith("You help an English-speaking learner read Japanese manga."));
  assert.ok(SYSTEM_PROMPT.endsWith("- Keep it short. Output JSON only."));
});

test("parse truncates and filters", () => {
  const data = {
    ...GOOD,
    notes: Array.from({ length: 7 }, (_, i) => ({ focus: String(i), explanation: "x" })),
    suggestions: [
      { word: "a", reading: "あ", meaning: "m" },
      { word: "b", meaning: "m" },
      ...Array.from({ length: 5 }, (_, i) => ({ word: `w${i}`, reading: "r", meaning: "m" })),
    ],
  };
  const out = parseExplanation(JSON.stringify(data));
  assert.equal(out.notes.length, 5);
  assert.equal(out.suggestions.length, 4);
  assert.ok(out.suggestions.every((s) => s.reading));
});

test("parse drops notes without explanation and accepts an object", () => {
  const out = parseExplanation({ translation: "t", notes: [{ focus: "a" }, { focus: "b", explanation: "e" }, "junk"], suggestions: null });
  assert.deepEqual(out, { translation: "t", notes: [{ focus: "b", explanation: "e" }], suggestions: [] });
});

test("parse bad JSON", () => {
  assert.throws(() => parseExplanation("not json"), { kind: "bad_response" });
});

test("parse missing translation", () => {
  assert.throws(() => parseExplanation(JSON.stringify({ notes: [] })), { kind: "bad_response" });
  assert.throws(() => parseExplanation("[]"), { kind: "bad_response" });
  assert.throws(() => parseExplanation(null), { kind: "bad_response" });
});

// ---- own key (port of the DeepSeekClient tests) ----

test("no key: no_api_key and no fetch", async () => {
  const f = fakeFetch(() => jsonResponse(200, {}));
  assert.deepEqual(await run("x", own({ apiKey: "" }), f), { ok: false, error: "no_api_key" });
  assert.equal(f.calls.length, 0);
});

test("own key: 401 and 403 map to auth", async () => {
  for (const status of [401, 403]) {
    const f = fakeFetch(() => jsonResponse(status, { error: {} }));
    assert.deepEqual(await run("x", own({ apiKey: "sk-bad" }), f), { ok: false, error: "auth" });
  }
});

test("own key: network error", async () => {
  const f = fakeFetch(() => { throw new TypeError("down"); });
  assert.deepEqual(await run("x", own(), f), { ok: false, error: "network" });
});

test("own key: success sends bearer, v1 body, DeepSeek URL; stores under explanationKey", async () => {
  const f = fakeFetch(() => jsonResponse(200, chatPayload()));
  const store = fakeStore();
  const out = await run(TEXT, own(), f, store);
  assert.deepEqual(out, { ok: true, result: GOOD, cached: false, remaining: null });
  const c = f.calls[0];
  assert.equal(c.url, "https://api.deepseek.com/chat/completions");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.Authorization, "Bearer sk-ok");
  assert.equal(c.init.headers["Content-Type"], "application/json");
  assert.deepEqual(c.body, {
    model: "deepseek-flash",
    messages: buildMessages(TEXT),
    response_format: { type: "json_object" },
    max_tokens: 700,
    stream: false,
  });
  assert.deepEqual(store.data.get(await store.explanationKey(TEXT)), GOOD);
});

test("own key: 402 no_balance, 429 rate_limited, other status bad_response", async () => {
  for (const [status, error] of [[402, "no_balance"], [429, "rate_limited"], [500, "bad_response"]]) {
    const f = fakeFetch(() => jsonResponse(status, {}));
    assert.deepEqual(await run("x", own(), f), { ok: false, error });
  }
});

test("own key: unexpected payload or non-JSON content is bad_response and not cached", async () => {
  const store = fakeStore();
  assert.deepEqual(await run("x", own(), fakeFetch(() => jsonResponse(200, { choices: [] })), store), { ok: false, error: "bad_response" });
  assert.deepEqual(await run("x", own(), fakeFetch(() => new Response("<html>", { status: 200 })), store), { ok: false, error: "bad_response" });
  const notJson = { choices: [{ message: { content: "sorry" } }] };
  assert.deepEqual(await run("x", own(), fakeFetch(() => jsonResponse(200, notJson)), store), { ok: false, error: "bad_response" });
  assert.equal(store.data.size, 0);
});

test("custom provider uses baseUrl without trailing slashes and the configured model", async () => {
  const f = fakeFetch(() => jsonResponse(200, chatPayload()));
  await run("x", own({ provider: "custom", baseUrl: "https://llm.example.test/v1//", model: "my-model" }), f);
  assert.equal(f.calls[0].url, "https://llm.example.test/v1/chat/completions");
  assert.equal(f.calls[0].body.model, "my-model");
  const g = fakeFetch(() => jsonResponse(200, chatPayload()));
  await run("x", own({ provider: "custom", baseUrl: "https://llm.example.test/v1", model: "" }), g);
  assert.equal(g.calls[0].body.model, "deepseek-flash");
});

test("own key sends the full text even over 300 chars", async () => {
  const long = "あ".repeat(450);
  const f = fakeFetch(() => jsonResponse(200, chatPayload()));
  await run(long, own(), f);
  assert.equal(f.calls[0].body.messages[1].content, long);
});

// ---- input and cache ----

test("empty or whitespace text: no_text and no fetch", async () => {
  const f = fakeFetch(() => jsonResponse(200, {}));
  for (const t of ["", "  \n\t", "　"]) assert.deepEqual(await run(t, own(), f), { ok: false, error: "no_text" });
  assert.deepEqual(await run("", free(), f), { ok: false, error: "no_text" });
  assert.equal(f.calls.length, 0);
});

test("local cache hit: no fetch, in both modes", async () => {
  const store = fakeStore({ [`key:${TEXT}`]: GOOD });
  const f = fakeFetch(() => jsonResponse(500, {}));
  assert.deepEqual(await run(TEXT, own(), f, store), { ok: true, result: GOOD, cached: true, remaining: null });
  assert.deepEqual(await run(` ${TEXT} `, free(), f, store), { ok: true, result: GOOD, cached: true, remaining: null });
  assert.equal(f.calls.length, 0);
});

test("second call for the same text is served from the cache", async () => {
  const f = fakeFetch(() => jsonResponse(200, chatPayload()));
  const store = fakeStore();
  const a = await run(TEXT, own(), f, store);
  const b = await run(TEXT, own(), f, store);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(f.calls.length, 1);
});

// ---- free tier ----

test("FREE_URL points at the deployed Worker, and the manifest grants its host", () => {
  assert.equal(FREE_URL, "https://anki-manga-free.suraba03.workers.dev/explain");
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.host_permissions.includes("https://anki-manga-free.suraba03.workers.dev/*"));
});

test("empty freeUrl in free mode is free_unavailable with no fetch", async () => {
  const f = fakeFetch(() => jsonResponse(200, {}));
  assert.deepEqual(await run("x", free(), f, fakeStore(), ""), { ok: false, error: "free_unavailable" });
  assert.equal(f.calls.length, 0);
});

test("free mode posts {install_id, text, prompt_version} and returns remaining from the header", async () => {
  const f = fakeFetch(() => jsonResponse(200, { result: GOOD }, { "X-Free-Remaining": "17" }));
  const store = fakeStore();
  const out = await run(TEXT, free(), f, store);
  assert.deepEqual(out, { ok: true, result: GOOD, cached: false, remaining: 17 });
  const c = f.calls[0];
  assert.equal(c.url, FREE_URL_TEST);
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers["Content-Type"], "application/json");
  assert.equal(c.init.headers.Authorization, undefined);
  assert.deepEqual(c.body, { install_id: "inst-1", text: TEXT, prompt_version: 1 });
  assert.deepEqual(store.data.get(await store.explanationKey(TEXT)), GOOD);
});

test("free mode: remaining is null when the header is absent or unparseable", async () => {
  for (const headers of [{}, { "X-Free-Remaining": "lots" }]) {
    const f = fakeFetch(() => jsonResponse(200, { result: GOOD }, headers));
    assert.equal((await run("x", free(), f)).remaining, null);
  }
});

test("free mode runs the result through parseExplanation", async () => {
  const messy = { translation: "t", notes: Array.from({ length: 9 }, () => ({ focus: "f", explanation: "e" })), suggestions: [{ word: "w" }] };
  const f = fakeFetch(() => jsonResponse(200, { result: messy }));
  const out = await run("x", free(), f);
  assert.equal(out.result.notes.length, 5);
  assert.deepEqual(out.result.suggestions, []);
});

test("free mode: 429 daily limit and monthly cap map to their codes, nothing cached", async () => {
  for (const error of ["free_daily_limit", "free_monthly_cap"]) {
    const f = fakeFetch(() => jsonResponse(429, { error }));
    const store = fakeStore();
    assert.deepEqual(await run(TEXT, free(), f, store), { ok: false, error });
    assert.equal(store.data.size, 0);
  }
});

test("free mode: other failures map to free_unavailable, nothing cached", async () => {
  const cases = [
    () => jsonResponse(429, { error: "something_else" }),
    () => jsonResponse(500, { error: "boom" }),
    () => jsonResponse(401, {}),
    () => new Response("not json", { status: 200 }),
    () => jsonResponse(200, {}),
    () => jsonResponse(200, { result: { notes: [] } }),
    () => { throw new TypeError("offline"); },
  ];
  for (const h of cases) {
    const store = fakeStore();
    assert.deepEqual(await run(TEXT, free(), fakeFetch(h), store), { ok: false, error: "free_unavailable" });
    assert.equal(store.data.size, 0);
  }
});

test("free mode over 300 chars sends the first 300 code points; cache key uses the full text", async () => {
  const long = "😀".repeat(299) + "あい";
  const f = fakeFetch(() => jsonResponse(200, { result: GOOD }));
  const store = fakeStore();
  await run(long, free(), f, store);
  assert.equal(f.calls[0].body.text, Array.from(long).slice(0, 300).join(""));
  assert.equal(Array.from(f.calls[0].body.text).length, 300);
  assert.ok(store.data.has(await store.explanationKey(long)));
});

test("free mode with exactly 300 chars is sent unchanged", async () => {
  const t = "あ".repeat(300);
  const f = fakeFetch(() => jsonResponse(200, { result: GOOD }));
  await run(t, free(), f);
  assert.equal(f.calls[0].body.text, t);
});

// ---- review fixes: timeout, best-effort cache, in-flight dedup ----

const hangingFetch = () =>
  fakeFetch(
    (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );

test("timeout: a hanging free-tier request is free_unavailable and nothing is cached", async () => {
  const store = fakeStore();
  const f = hangingFetch();
  assert.deepEqual(await explain("t1", { settings: free(), store, fetch: f, freeUrl: FREE_URL_TEST, timeoutMs: 20 }), { ok: false, error: "free_unavailable" });
  assert.equal(store.data.size, 0);
  assert.ok(f.calls[0].init.signal);
});

test("timeout: a hanging own-key request is network and nothing is cached", async () => {
  const store = fakeStore();
  assert.deepEqual(await explain("t2", { settings: own(), store, fetch: hangingFetch(), freeUrl: FREE_URL_TEST, timeoutMs: 20 }), { ok: false, error: "network" });
  assert.equal(store.data.size, 0);
});

test("timeout: a response body that hangs after the headers is also cut off", async () => {
  const slowBody = (_url, init) => {
    const resp = new Response("{}", { status: 200 });
    resp.json = () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    return resp;
  };
  assert.deepEqual(await explain("t3", { settings: own(), store: fakeStore(), fetch: fakeFetch(slowBody), timeoutMs: 20 }), { ok: false, error: "network" });
  assert.deepEqual(await explain("t3", { settings: free(), store: fakeStore(), fetch: fakeFetch(slowBody), freeUrl: FREE_URL_TEST, timeoutMs: 20 }), { ok: false, error: "free_unavailable" });
});

test("timeout: default is 30 s and a fast response clears the timer", async () => {
  const f = fakeFetch(() => jsonResponse(200, chatPayload()));
  const out = await run("t4", own(), f);
  assert.equal(out.ok, true);
  assert.equal(f.calls[0].init.signal.aborted, false);
});

test("cache read errors are a miss: the provider is still called", async () => {
  const f = fakeFetch(() => jsonResponse(200, chatPayload()));
  const store = { explanationKey: async () => { throw new Error("idb"); }, getExplanation: async () => { throw new Error("idb"); }, putExplanation: async () => { throw new Error("idb"); } };
  assert.deepEqual(await run("c1", own(), f, store), { ok: true, result: GOOD, cached: false, remaining: null });
  const store2 = { ...fakeStore(), getExplanation: async () => { throw new Error("idb"); } };
  assert.equal((await run("c1", own(), f, store2)).ok, true);
  assert.equal(f.calls.length, 2);
});

test("a failing cache write does not discard the result", async () => {
  const f = fakeFetch(() => jsonResponse(200, { result: GOOD }, { "X-Free-Remaining": "3" }));
  const store = { ...fakeStore(), putExplanation: async () => { throw new Error("quota"); } };
  assert.deepEqual(await run("c2", free(), f, store), { ok: true, result: GOOD, cached: false, remaining: 3 });
});

test("explain never rejects, even on an unexpected error", async () => {
  const bad = fakeFetch(() => ({ status: 200, ok: true, json: async () => { throw new Error("x"); } }));
  const out = await run("c3", own(), bad);
  assert.equal(out.ok, false);
});

test("concurrent calls for the same text share one request", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = fakeFetch(async () => { await gate; return jsonResponse(200, chatPayload()); });
  const store = fakeStore();
  const a = run("d1", own(), f, store);
  const b = run(" d1 ", own(), f, store);
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(f.calls.length, 1);
  assert.equal(ra.ok, true);
  assert.deepEqual(rb, ra);
  const c = await run("d1", own(), f, store);
  assert.equal(c.cached, true);
  assert.equal(f.calls.length, 1);
});

test("in-flight entry is removed after a failure, so a retry fetches again", async () => {
  const f = fakeFetch(() => jsonResponse(500, {}));
  const store = fakeStore();
  const [a, b] = await Promise.all([run("d2", own(), f, store), run("d2", own(), f, store)]);
  assert.deepEqual(a, { ok: false, error: "bad_response" });
  assert.deepEqual(b, a);
  assert.equal(f.calls.length, 1);
  await run("d2", own(), f, store);
  assert.equal(f.calls.length, 2);
});

// ---- diagnostics: onError gets the concrete cause, never the API key ----

const withLog = (text, settings, fetch, opts = {}) => {
  const log = [];
  const p = explain(text, { settings, store: fakeStore(), fetch, freeUrl: FREE_URL_TEST, onError: (d) => log.push(d), ...opts });
  return p.then((r) => ({ r, log }));
};

test("onError: free HTTP failure reports the status and the server's error code", async () => {
  const { r, log } = await withLog(TEXT, free(), fakeFetch(() => jsonResponse(502, { error: "upstream_failed" })));
  assert.deepEqual(r, { ok: false, error: "free_unavailable" });
  assert.equal(log.length, 1);
  assert.match(log[0], /free_unavailable/);
  assert.match(log[0], /HTTP 502/);
  assert.match(log[0], /upstream_failed/);
});

test("onError: a thrown fetch reports the network error; a timeout says timeout", async () => {
  const boom = fakeFetch(() => { throw new TypeError("Failed to fetch"); });
  const a = await withLog(TEXT, free(), boom);
  assert.match(a.log[0], /Failed to fetch/);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  const b = await withLog(TEXT, own(), hang, { timeoutMs: 20 });
  assert.deepEqual(b.r, { ok: false, error: "network" });
  assert.match(b.log[0], /timeout/);
});

test("onError: own-key HTTP failure carries the provider's message but not the key", async () => {
  const f = fakeFetch(() => jsonResponse(400, { error: { message: "Model Not Exist" } }));
  const { r, log } = await withLog(TEXT, own({ apiKey: "sk-secret-123" }), f);
  assert.deepEqual(r, { ok: false, error: "bad_response" });
  assert.match(log[0], /HTTP 400/);
  assert.match(log[0], /Model Not Exist/);
  assert.doesNotMatch(log[0], /sk-secret-123/);
});

test("onError: an unparseable success says so", async () => {
  const { log } = await withLog(TEXT, own(), fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: "not json" } }] })));
  assert.match(log[0], /bad_response/);
  assert.match(log[0], /invalid JSON/);
});

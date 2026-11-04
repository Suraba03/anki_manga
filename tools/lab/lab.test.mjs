// Pure parts of the lab: LLM modes, the replay cache key, the live budget, the report diff and markdown.
import test from "node:test";
import assert from "node:assert/strict";
import { parseLlmMode, cacheKey, createBudget, answerFor, userText, chatPayload, STUB } from "./llm.mjs";
import { STEPS, mark, combine, diffRuns, renderMarkdown, regressed } from "./report.mjs";

test("--llm: stub by default, replay, live:N with a positive budget; anything else is an error", () => {
  assert.deepEqual(parseLlmMode(undefined), { mode: "stub" });
  assert.deepEqual(parseLlmMode("stub"), { mode: "stub" });
  assert.deepEqual(parseLlmMode("replay"), { mode: "replay" });
  assert.deepEqual(parseLlmMode("live:5"), { mode: "live", budget: 5 });
  for (const bad of ["live", "live:0", "live:-1", "live:x", "free", "LIVE:3"]) assert.throws(() => parseLlmMode(bad), /--llm/);
});

test("cache key: prompt version plus the normalized, trimmed text", () => {
  assert.equal(cacheKey(3, "  見りゃ分かる  "), "3\n見りゃ分かる");
  assert.equal(cacheKey(3, "ｱｲｳ"), cacheKey(3, "アイウ"), "NFKC");
  assert.notEqual(cacheKey(3, "a"), cacheKey(4, "a"), "a new prompt version misses");
});

test("budget: at most N takes, then none", () => {
  const b = createBudget(2);
  assert.deepEqual([b.take(), b.take(), b.take()], [true, true, false]);
  assert.equal(b.used, 2);
});

test("the user text comes from the chat request", () => {
  assert.equal(userText({ messages: [{ role: "system", content: "s" }, { role: "user", content: "台詞" }] }), "台詞");
  assert.equal(userText({}), "");
});

test("stub: a valid explanation, no cache use, no live call", async () => {
  let live = 0;
  const r = await answerFor({ mode: "stub" }, "台詞", { cache: {}, promptVersion: 1, callLive: async () => (live++, "x") });
  assert.equal(r.source, "stub");
  assert.deepEqual(JSON.parse(r.content), STUB);
  assert.equal(live, 0);
});

test("replay: a hit answers from the cache; a miss falls back to the stub and says so", async () => {
  const cache = { [cacheKey(1, "台詞")]: '{"translation":"Lines","notes":[],"suggestions":[]}' };
  const hit = await answerFor({ mode: "replay" }, "台詞", { cache, promptVersion: 1 });
  assert.deepEqual(hit, { source: "replay", content: cache[cacheKey(1, "台詞")] });
  const miss = await answerFor({ mode: "replay" }, "別", { cache, promptVersion: 1 });
  assert.equal(miss.source, "stub (replay miss)");
});

test("live: real calls up to the budget, each written to the cache; then replay, then stub", async () => {
  const cache = {};
  const budget = createBudget(1);
  const calls = [];
  const callLive = async (text) => (calls.push(text), `{"translation":"live ${text}"}`);
  const ctx = { cache, promptVersion: 1, budget, callLive };
  assert.equal((await answerFor({ mode: "live", budget: 1 }, "一", ctx)).source, "live");
  assert.equal(cache[cacheKey(1, "一")], '{"translation":"live 一"}');
  assert.equal((await answerFor({ mode: "live", budget: 1 }, "一", ctx)).source, "replay", "a cached text costs nothing");
  assert.equal((await answerFor({ mode: "live", budget: 1 }, "二", ctx)).source, "stub (live budget used up)");
  assert.deepEqual(calls, ["一"]);
});

test("live: a failed call is not cached and falls back to the stub", async () => {
  const cache = {};
  const r = await answerFor({ mode: "live", budget: 3 }, "一", { cache, promptVersion: 1, budget: createBudget(3), callLive: async () => { throw new Error("HTTP 500"); } });
  assert.equal(r.source, "stub (live failed: HTTP 500)");
  assert.deepEqual(cache, {});
});

test("the chat payload is what an OpenAI-style client reads", () => {
  assert.deepEqual(chatPayload("{}"), { choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: {} });
});

// ---- report --------------------------------------------------------------------------------------------

const run = (sites) => ({ stamp: "s", lane: "B", sites });
const site = (name, steps) => ({ name, steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v === true ? { ok: true } : v === false ? { ok: false, note: "x" } : { ok: null }])) });

test("mark: ✓, ✗ and – for not reached", () => {
  assert.equal(mark({ ok: true }), "✓");
  assert.equal(mark({ ok: false }), "✗");
  assert.equal(mark({ ok: null }), "–");
  assert.equal(mark(undefined), "–");
});

test("diff: per site and step, only changes; a ✓ that is lost is a regression", () => {
  const prev = run([site("s1", { open: true, text: true }), site("s2", { open: true, text: false })]);
  const cur = run([site("s1", { open: true, text: false }), site("s2", { open: true, text: true }), site("s3", { open: true })]);
  const d = diffRuns(prev, cur);
  assert.deepEqual(d, [
    { site: "s1", step: "text", from: "✓", to: "✗", regression: true },
    { site: "s2", step: "text", from: "✗", to: "✓", regression: false },
  ]);
  assert.equal(regressed(d), true);
  assert.equal(regressed(d.slice(1)), false);
});

test("diff: no previous run, or a site not in it, gives no changes", () => {
  assert.deepEqual(diffRuns(null, run([site("s1", { open: true })])), []);
  assert.deepEqual(diffRuns(run([]), run([site("s1", { open: false })])), []);
});

test("diff: ✓ → – (not reached any more) is a regression too", () => {
  const d = diffRuns(run([site("s1", { card: true })]), run([site("s1", { card: null })]));
  assert.deepEqual(d, [{ site: "s1", step: "card", from: "✓", to: "–", regression: true }]);
});

test("markdown: one row per site with every step, the notes of failures, and the diff", () => {
  const cur = run([{ ...site("s1", { open: true, text: false }), timings: { firstBubbleMs: 4200, firstTextMs: 6100 } }]);
  cur.sites[0].steps.text.note = "panel showed nothing";
  const md = renderMarkdown(cur, [{ site: "s1", step: "text", from: "✓", to: "✗", regression: true }]);
  assert.match(md, new RegExp(`\\| site \\| ${STEPS.join(" \\| ")} \\|`));
  assert.match(md, /\| s1 \| ✓ \| /);
  assert.match(md, /panel showed nothing/);
  assert.match(md, /4\.2 s/);
  assert.match(md, /s1: text ✓→✗ \(regression\)/);
});

test("combine: all reached passed → ✓ (with a count when some were not reached); any failure → ✗ with its note", () => {
  assert.deepEqual(combine([{ ok: true }, { ok: true }]), { ok: true });
  assert.deepEqual(combine([{ ok: true }, { ok: null, note: "no kanji" }]), { ok: true, note: "1/2 checked" });
  assert.deepEqual(combine([{ ok: true }, { ok: false, note: "kanji without readings" }, { ok: false, note: "other" }]), { ok: false, note: "2/3: kanji without readings" });
  assert.deepEqual(combine([{ ok: null, note: "no kanji in the line" }, undefined]), { ok: null, note: "no kanji in the line" });
  assert.deepEqual(combine([]), { ok: null });
});

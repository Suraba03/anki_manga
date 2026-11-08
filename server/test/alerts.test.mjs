import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTelegram, makeNotifier, alertText } from "../src/alerts.js";

const TOKEN = "123456:SECRET-token";
const OK = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

test("sendTelegram posts chat_id, text and disable_web_page_preview as JSON to the bot's sendMessage", async () => {
  let seen;
  await sendTelegram("hello", {
    token: TOKEN,
    chatId: "42",
    fetch: async (url, init) => ((seen = { url, init }), OK()),
  });
  assert.equal(seen.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen.init.body), { chat_id: "42", text: "hello", disable_web_page_preview: true });
});

test("sendTelegram throws an error with the status on a non-2xx, and the message holds neither token nor URL", async () => {
  const e = await sendTelegram("x", { token: TOKEN, chatId: "1", fetch: async () => new Response("nope", { status: 401 }) }).catch((err) => err);
  assert.ok(e instanceof Error);
  assert.equal(e.status, 401);
  assert.ok(!e.message.includes("SECRET") && !e.message.includes("telegram.org"), e.message);
});

test("makeNotifier is null unless both Telegram secrets are set", () => {
  assert.equal(makeNotifier({}), null);
  assert.equal(makeNotifier({ TELEGRAM_BOT_TOKEN: TOKEN }), null);
  assert.equal(makeNotifier({ TELEGRAM_CHAT_ID: "1" }), null);
  assert.equal(makeNotifier({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "1" }), null);
  assert.equal(typeof makeNotifier({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "1" }), "function");
});

test("makeNotifier sends through Telegram, and a failing sender's error propagates", async () => {
  const sent = [];
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42" };
  const notify = makeNotifier(env, { fetch: async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), OK()) });
  assert.equal(await notify("hi"), undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, "hi");
  const bad = makeNotifier(env, { fetch: async () => new Response("", { status: 500 }) });
  await assert.rejects(bad("hi"), (e) => e.status === 500);
});

test("alert texts are short plain text with amounts to two decimals", () => {
  assert.equal(
    alertText("month_80", { used: 8.0123, cap: 10, month: "2026-11" }),
    "anki-manga free tier: 80% of the monthly budget used (8.01 of 10 USD, 2026-11).",
  );
  assert.equal(
    alertText("month_100", { used: 10.03, cap: 10, month: "2026-11" }),
    "anki-manga free tier: 100% of the monthly budget used (10.03 of 10 USD, 2026-11); the free tier is now off until 2026-12-01 (UTC).",
  );
  assert.equal(
    alertText("day_spike", { usd: 2.6, day: "2026-11-08", threshold: 2.5 }),
    "anki-manga free tier: unusual daily spend: 2.6 USD on 2026-11-08 (alert threshold 2.5 USD).",
  );
  assert.equal(
    alertText("test", { at: new Date("2026-11-08T10:00:00Z") }),
    "anki-manga free tier: test alert (sent at 2026-11-08T10:00:00.000Z).",
  );
});

test("the 100% text names the 1st of next month across a year end", () => {
  assert.match(alertText("month_100", { used: 10, cap: 10, month: "2026-12" }), /off until 2027-01-01 \(UTC\)\.$/);
});

test("an unknown alert kind throws", () => {
  assert.throws(() => alertText("nope", {}));
});

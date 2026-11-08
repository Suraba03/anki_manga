import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { makeD1Db } from "../src/worker.js";
import { prune, RETENTION } from "../src/prune.js";

// A D1-shaped adapter over node:sqlite, loaded with the real schema.sql, so the SQL is actually executed.
let sqlite;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}
const skip = sqlite ? false : "node:sqlite is not available in this Node";

function d1() {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const binding = {
    raw: db,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
      }),
    }),
  };
  return binding;
}

const DAY = 86400000;
const NOW = new Date("2026-11-10T03:17:00Z");
const ms = (daysAgo) => NOW.getTime() - daysAgo * DAY;
const keys = (b, table, col) => b.raw.prepare(`SELECT ${col} AS k FROM ${table} ORDER BY ${col}`).all().map((r) => r.k);

test("retention periods are 2 days, 13 months and 180 days", () => {
  assert.deepEqual(RETENTION, { counterDays: 2, spendMonths: 13, cacheDays: 180 });
});

test("prune deletes counters older than 2 days, spend older than 13 months, cache unused for 180 days", { skip }, async () => {
  const b = d1();
  const ins = (sql, ...a) => b.raw.prepare(sql).run(...a);
  for (const day of ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"]) {
    ins("INSERT INTO install_counts (day, id, n) VALUES (?, 'i', 1)", day);
    ins("INSERT INTO ip_counts (day, h, n) VALUES (?, 'h', 1)", day);
  }
  for (const month of ["2025-09", "2025-10", "2025-11", "2026-11"]) ins("INSERT INTO spend (month, usd) VALUES (?, 1)", month);
  for (const day of ["2026-11-07", "2026-11-08", "2026-11-10"]) ins("INSERT INTO spend_days (day, usd) VALUES (?, 1)", day);
  // created long ago but used recently -> kept; created long ago and never used -> gone; used 181 days ago -> gone
  ins("INSERT INTO cache (key, text, result, created_at, last_used) VALUES ('used', 't', '{}', ?, ?)", ms(400), ms(10));
  ins("INSERT INTO cache (key, text, result, created_at, last_used) VALUES ('old', 't', '{}', ?, NULL)", ms(181));
  ins("INSERT INTO cache (key, text, result, created_at, last_used) VALUES ('stale', 't', '{}', ?, ?)", ms(200), ms(181));
  ins("INSERT INTO cache (key, text, result, created_at, last_used) VALUES ('new', 't', '{}', ?, NULL)", ms(1));
  ins("INSERT INTO cache (key, text, result, created_at, last_used) VALUES ('edge', 't', '{}', ?, NULL)", ms(179));

  await prune({ DB: b }, NOW);

  assert.deepEqual(keys(b, "install_counts", "day"), ["2026-11-08", "2026-11-09", "2026-11-10"]);
  assert.deepEqual(keys(b, "ip_counts", "day"), ["2026-11-08", "2026-11-09", "2026-11-10"]);
  assert.deepEqual(keys(b, "spend", "month"), ["2025-10", "2025-11", "2026-11"]);
  assert.deepEqual(keys(b, "spend_days", "day"), ["2026-11-08", "2026-11-10"]);
  assert.deepEqual(keys(b, "cache", "key"), ["edge", "new", "used"]);
});

test("prune returns how many rows it deleted per table", { skip }, async () => {
  const b = d1();
  const ins = (sql, ...a) => b.raw.prepare(sql).run(...a);
  ins("INSERT INTO install_counts (day, id, n) VALUES ('2026-11-01', 'i', 1)");
  ins("INSERT INTO ip_counts (day, h, n) VALUES ('2026-11-01', 'h', 1)");
  ins("INSERT INTO spend (month, usd) VALUES ('2020-01', 1)");
  ins("INSERT INTO spend_days (day, usd) VALUES ('2026-11-01', 1)");
  ins("INSERT INTO alerts (period, kind, sent_at) VALUES ('2020-01', 'month_80', 1)");
  assert.deepEqual(await prune({ DB: b }, NOW), { installCounts: 1, ipCounts: 1, spend: 1, spendDays: 1, alerts: 1, cache: 0 });
});

test("prune keeps recent alerts, whether their period is a month or a day, and removes old ones of both", { skip }, async () => {
  const b = d1();
  const put = (period, kind) => b.raw.prepare("INSERT INTO alerts (period, kind, sent_at) VALUES (?, ?, 1)").run(period, kind);
  // now = 2026-11-10: the cutoff is the month 13 months back, 2025-10
  put("2025-09", "month_80");
  put("2025-09-30", "day_spike");
  put("2025-10", "month_100");
  put("2025-10-01", "day_spike");
  put("2026-11", "month_80");
  put("2026-11-08", "day_spike");
  await prune({ DB: b }, NOW);
  assert.deepEqual(keys(b, "alerts", "period"), ["2025-10", "2025-10-01", "2026-11", "2026-11-08"]);
});

test("makeD1Db against the real schema: totals accumulate, a claim is made once, a release lets it be claimed again", { skip }, async () => {
  const b = d1();
  const db = makeD1Db(b, () => 1700000000000);
  assert.equal(await db.addSpend("2026-11", 0.25), 0.25);
  assert.equal(await db.addSpend("2026-11", 0.5), 0.75);
  assert.equal(await db.addSpend("2026-12", 1), 1);
  assert.equal(await db.getSpend("2026-11"), 0.75);
  assert.equal(await db.addDaySpend("2026-11-08", 1.5), 1.5);
  assert.equal(await db.addDaySpend("2026-11-08", 1), 2.5);
  assert.equal(await db.addDaySpend("2026-11-09", 2), 2);

  assert.equal(await db.claimAlert("2026-11", "month_80", 5), true);
  assert.equal(await db.claimAlert("2026-11", "month_80", 6), false);
  assert.equal(await db.claimAlert("2026-11", "month_100", 6), true);
  assert.equal(await db.claimAlert("2026-12", "month_80", 7), true);
  assert.equal(b.raw.prepare("SELECT sent_at AS s FROM alerts WHERE period = '2026-11' AND kind = 'month_80'").get().s, 5);
  await db.releaseAlert("2026-11", "month_80");
  assert.equal(await db.claimAlert("2026-11", "month_80", 8), true);
});

test("prune works across a year boundary", { skip }, async () => {
  const b = d1();
  for (const month of ["2024-11", "2024-12", "2025-01", "2026-01"]) b.raw.prepare("INSERT INTO spend (month, usd) VALUES (?, 1)").run(month);
  await prune({ DB: b }, new Date("2026-01-05T03:17:00Z")); // 13 months back = 2024-12
  assert.deepEqual(keys(b, "spend", "month"), ["2024-12", "2025-01", "2026-01"]);
});

test("a cache hit refreshes last_used at most once a day", { skip }, async () => {
  const b = d1();
  let now = NOW.getTime();
  const db = makeD1Db(b, () => now);
  await db.putCache("k", "text", { translation: "x" });
  const lastUsed = () => b.raw.prepare("SELECT last_used AS l FROM cache WHERE key = 'k'").get().l;
  assert.equal(lastUsed(), null);

  now += 1000;
  assert.deepEqual(await db.getCache("k"), { translation: "x" });
  assert.equal(lastUsed(), null, "a hit within a day of creation writes nothing");

  now += 2 * DAY;
  await db.getCache("k");
  assert.equal(lastUsed(), now, "a hit after a day refreshes last_used");

  const before = now;
  now += 3600000;
  await db.getCache("k");
  assert.equal(lastUsed(), before, "a second hit within a day writes nothing");
});

test("a failing last_used update does not break a cache hit", async () => {
  const d = {
    prepare: (sql) => ({
      bind: () => ({
        first: async () => ({ result: JSON.stringify({ translation: "x" }), created_at: 0, last_used: null }),
        run: async () => {
          if (/UPDATE cache/.test(sql)) throw new Error("d1 down");
        },
      }),
    }),
  };
  assert.deepEqual(await makeD1Db(d, () => 10 * DAY).getCache("k"), { translation: "x" });
});

test("the scheduled handler runs prune through waitUntil", { skip }, async () => {
  const b = d1();
  b.raw.prepare("INSERT INTO install_counts (day, id, n) VALUES ('2000-01-01', 'i', 1)").run();
  const pending = [];
  const e = mock.method(console, "error", () => {}); // no config vars here: the alert check logs that it cannot run
  worker.scheduled({ cron: "17 3 * * *" }, { DB: b }, { waitUntil: (p) => pending.push(p) });
  assert.equal(pending.length, 2, "prune and the alert check");
  await Promise.all(pending);
  e.mock.restore();
  assert.deepEqual(keys(b, "install_counts", "day"), []);
});

test("wrangler.toml schedules the daily cleanup", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /^\[triggers\]\s*\ncrons = \["17 3 \* \* \*"\]$/m);
});

test("schema.sql has last_used and an ALTER note for existing databases", () => {
  const sql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  assert.match(sql, /last_used\s+INTEGER/);
  assert.match(sql, /ALTER TABLE cache ADD COLUMN last_used INTEGER/);
});

// ---- the cron: prune, then the month-alert safety net, independently ----
const ENV_VARS = {
  DAILY_PER_INSTALL: "100", DAILY_PER_IP: "300", MONTHLY_CAP_USD: "10",
  PRICE_IN_HIT: "0.000001", PRICE_IN_MISS: "0.00001", PRICE_OUT: "0.0001",
  TELEGRAM_BOT_TOKEN: "123:SECRET-TOKEN", TELEGRAM_CHAT_ID: "42",
};
const thisMonth = () => new Date().toISOString().slice(0, 7);
const logged = (m) => m.mock.calls.map((c) => c.arguments.join(" ")).join("\n");

// Telegram stand-in: the cron has no fetch injection, so it is the global one.
function telegram(status = 200) {
  const sent = [];
  const f = mock.method(globalThis, "fetch", async (url, init) => (sent.push({ url, text: JSON.parse(init.body).text }), new Response("{}", { status })));
  return { sent, restore: () => f.mock.restore() };
}

test("the scheduled handler also runs the month-alert check: a missing 80% alert is sent once", { skip }, async () => {
  const b = d1();
  b.raw.prepare("INSERT INTO spend (month, usd) VALUES (?, 8.5)").run(thisMonth());
  const tg = telegram();
  const w = mock.method(console, "warn", () => {});
  try {
    for (let run = 0; run < 2; run++) {
      const pending = [];
      worker.scheduled({ cron: "17 3 * * *" }, { ...ENV_VARS, DB: b }, { waitUntil: (p) => pending.push(p) });
      assert.equal(pending.length, 2, "prune and the alert check, each under waitUntil");
      await Promise.all(pending);
    }
    assert.equal(tg.sent.length, 1, "the second run finds the alert claimed");
    assert.match(tg.sent[0].text, /80% of the monthly budget used \(8\.5 of 10 USD/);
    assert.equal(tg.sent[0].url, "https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage");
  } finally {
    tg.restore();
    w.mock.restore();
  }
});

test("a failed send is retried by the next cron run", { skip }, async () => {
  const b = d1();
  b.raw.prepare("INSERT INTO spend (month, usd) VALUES (?, 8.5)").run(thisMonth());
  const w = mock.method(console, "warn", () => {});
  const e = mock.method(console, "error", () => {});
  try {
    const down = telegram(500);
    const first = [];
    worker.scheduled({}, { ...ENV_VARS, DB: b }, { waitUntil: (p) => first.push(p) });
    await Promise.all(first);
    down.restore();
    assert.equal(b.raw.prepare("SELECT COUNT(*) AS n FROM alerts").get().n, 0);
    assert.match(logged(e), /alert failed/);
    assert.ok(!logged(e).includes("SECRET-TOKEN") && !logged(e).includes("telegram.org"), logged(e));

    const up = telegram();
    const second = [];
    worker.scheduled({}, { ...ENV_VARS, DB: b }, { waitUntil: (p) => second.push(p) });
    await Promise.all(second);
    assert.equal(up.sent.length, 1);
    up.restore();
  } finally {
    w.mock.restore();
    e.mock.restore();
  }
});

test("a failing prune does not stop the alert check, and a failing alert check does not stop prune", { skip }, async () => {
  const w = mock.method(console, "warn", () => {});
  const e = mock.method(console, "error", () => {});
  const tg = telegram();
  try {
    // prune's DELETEs throw
    const b = d1();
    b.raw.prepare("INSERT INTO spend (month, usd) VALUES (?, 8.5)").run(thisMonth());
    const noDelete = {
      prepare: (sql) => {
        if (/^DELETE/.test(sql)) throw new Error("d1 down");
        return b.prepare(sql);
      },
    };
    const pending = [];
    worker.scheduled({}, { ...ENV_VARS, DB: noDelete }, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.equal(tg.sent.length, 1);
    assert.match(logged(e), /prune failed/);

    // the alert check throws (bad config), prune still runs
    const c = d1();
    c.raw.prepare("INSERT INTO install_counts (day, id, n) VALUES ('2000-01-01', 'i', 1)").run();
    const more = [];
    worker.scheduled({}, { ...ENV_VARS, MONTHLY_CAP_USD: "x", DB: c }, { waitUntil: (p) => more.push(p) });
    await Promise.all(more);
    assert.deepEqual(keys(c, "install_counts", "day"), []);
    assert.match(logged(e), /alert check failed/);
  } finally {
    tg.restore();
    w.mock.restore();
    e.mock.restore();
  }
});

test("a database without the newer tables still gets the older cleanups, and the missing ones count 0", { skip }, async () => {
  const b = d1();
  b.raw.exec("DROP TABLE spend_days; DROP TABLE alerts");
  b.raw.prepare("INSERT INTO install_counts (day, id, n) VALUES ('2000-01-01', 'i', 1)").run();
  b.raw.prepare("INSERT INTO spend (month, usd) VALUES ('2000-01', 1)").run();
  b.raw.prepare("INSERT INTO cache (key, text, result, created_at, last_used) VALUES ('old', 't', '{}', 1, NULL)").run();
  const e = mock.method(console, "error", () => {});
  try {
    const counts = await prune({ DB: b }, NOW);
    assert.deepEqual(counts, { installCounts: 1, ipCounts: 0, spend: 1, cache: 1, spendDays: 0, alerts: 0 });
    assert.deepEqual(keys(b, "cache", "key"), []);
    const logged = e.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(logged, /spend_days/);
    assert.match(logged, /alerts/);
    assert.doesNotMatch(logged, /no such table/, "describeError logs names, not messages");
  } finally {
    e.mock.restore();
  }
});

test("a failing older cleanup still stops prune (the cron logs it)", { skip }, async () => {
  const b = d1();
  b.raw.exec("DROP TABLE ip_counts");
  await assert.rejects(prune({ DB: b }, NOW));
});

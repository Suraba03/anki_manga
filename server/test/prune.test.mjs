import { test } from "node:test";
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
  assert.deepEqual(keys(b, "cache", "key"), ["edge", "new", "used"]);
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
  worker.scheduled({ cron: "17 3 * * *" }, { DB: b }, { waitUntil: (p) => pending.push(p) });
  assert.equal(pending.length, 1);
  await Promise.all(pending);
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

// Daily cleanup of the free tier's D1 tables (run by the Worker's cron trigger, see wrangler.toml).
import { describeError } from "./explain.js";

// docs/privacy.md states these periods: keep them in sync.
export const RETENTION = { counterDays: 2, spendMonths: 13, cacheDays: 180 };

const DAY_MS = 86400000;

// env.DB: the D1 binding. now: Date. -> number of rows deleted per table.
export async function prune(env, now = new Date()) {
  const counterCutoff = new Date(now.getTime() - RETENTION.counterDays * DAY_MS).toISOString().slice(0, 10);
  const monthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth() - RETENTION.spendMonths;
  const spendCutoff = `${Math.floor(monthIndex / 12)}-${String((monthIndex % 12) + 1).padStart(2, "0")}`;
  const cacheCutoff = now.getTime() - RETENTION.cacheDays * DAY_MS;

  const run = async (sql, cutoff) => (await env.DB.prepare(sql).bind(cutoff).run())?.meta?.changes ?? 0;
  // The tables added later (spend_days, alerts) are cleaned last and each on its own: if the database was not
  // migrated yet, that must not stop the older cleanups. The older ones still throw (the cron logs it).
  const counts = {
    installCounts: await run("DELETE FROM install_counts WHERE day < ?", counterCutoff),
    ipCounts: await run("DELETE FROM ip_counts WHERE day < ?", counterCutoff),
    spend: await run("DELETE FROM spend WHERE month < ?", spendCutoff),
    cache: await run("DELETE FROM cache WHERE COALESCE(last_used, created_at) < ?", cacheCutoff),
  };
  const runNew = async (name, sql, cutoff) => {
    try {
      return await run(sql, cutoff);
    } catch (e) {
      console.error(`free tier: prune of ${name} failed:`, describeError(e));
      return 0;
    }
  };
  counts.spendDays = await runNew("spend_days", "DELETE FROM spend_days WHERE day < ?", counterCutoff);
  // period is YYYY-MM or YYYY-MM-DD: by string order both are < the YYYY-MM cutoff exactly when they are older than it
  // (a day in the cutoff month is longer than the cutoff string, so it stays one more month).
  counts.alerts = await runNew("alerts", "DELETE FROM alerts WHERE period < ?", spendCutoff);
  return counts;
}

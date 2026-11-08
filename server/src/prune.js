// Daily cleanup of the free tier's D1 tables (run by the Worker's cron trigger, see wrangler.toml).
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
  return {
    installCounts: await run("DELETE FROM install_counts WHERE day < ?", counterCutoff),
    ipCounts: await run("DELETE FROM ip_counts WHERE day < ?", counterCutoff),
    spend: await run("DELETE FROM spend WHERE month < ?", spendCutoff),
    spendDays: await run("DELETE FROM spend_days WHERE day < ?", counterCutoff),
    // period is YYYY-MM or YYYY-MM-DD: by string order both are < the YYYY-MM cutoff exactly when they are older than it
    // (a day in the cutoff month is longer than the cutoff string, so it stays one more month).
    alerts: await run("DELETE FROM alerts WHERE period < ?", spendCutoff),
    cache: await run("DELETE FROM cache WHERE COALESCE(last_used, created_at) < ?", cacheCutoff),
  };
}

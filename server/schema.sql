-- Free-tier state in D1. Apply once: npx wrangler d1 execute anki-manga --remote --file schema.sql

-- Shared explanation cache, keyed like the extension's: sha256("1\n" + NFKC(text).trim()).
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  result     TEXT NOT NULL,     -- JSON {translation, notes, suggestions}
  created_at INTEGER NOT NULL,  -- ms since epoch
  last_used  INTEGER            -- ms since epoch of the last cache hit, refreshed at most once a day; NULL = never hit
);
-- Existing database created before last_used: run once
--   npx wrangler d1 execute anki-manga --remote --command "ALTER TABLE cache ADD COLUMN last_used INTEGER"
-- (in SQL: ALTER TABLE cache ADD COLUMN last_used INTEGER;)
-- Retention is enforced by the daily cron (src/prune.js): cache rows unused for 180 days, counters older than
-- 2 days and spend older than 13 months are deleted. The manual prune statements below are no longer needed.

-- Paid calls per install per UTC day. Pruned after 2 days by the cron.
CREATE TABLE IF NOT EXISTS install_counts (
  day TEXT NOT NULL,            -- YYYY-MM-DD
  id  TEXT NOT NULL,            -- lower-case install UUID
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, id)
) WITHOUT ROWID;

-- Paid calls per salted IP hash per UTC day. Pruned after 2 days by the cron.
CREATE TABLE IF NOT EXISTS ip_counts (
  day TEXT NOT NULL,
  h   TEXT NOT NULL,            -- sha256(IP_SALT + ip), never the raw address
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, h)
) WITHOUT ROWID;

-- DeepSeek spend per UTC month, in USD. Pruned after 13 months by the cron.
CREATE TABLE IF NOT EXISTS spend (
  month TEXT PRIMARY KEY,       -- YYYY-MM
  usd   REAL NOT NULL DEFAULT 0
);

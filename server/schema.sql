-- Free-tier state in D1. Apply once: npx wrangler d1 execute anki-manga --remote --file schema.sql

-- Shared explanation cache, keyed like the extension's: sha256("1\n" + NFKC(text).trim()).
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  result     TEXT NOT NULL,     -- JSON {translation, notes, suggestions}
  created_at INTEGER NOT NULL   -- ms since epoch
);

-- Paid calls per install per UTC day. Prune: DELETE FROM install_counts WHERE day < date('now', '-7 days');
CREATE TABLE IF NOT EXISTS install_counts (
  day TEXT NOT NULL,            -- YYYY-MM-DD
  id  TEXT NOT NULL,            -- lower-case install UUID
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, id)
) WITHOUT ROWID;

-- Paid calls per salted IP hash per UTC day. Prune like install_counts.
CREATE TABLE IF NOT EXISTS ip_counts (
  day TEXT NOT NULL,
  h   TEXT NOT NULL,            -- sha256(IP_SALT + ip), never the raw address
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, h)
) WITHOUT ROWID;

-- DeepSeek spend per UTC month, in USD. Prune: DELETE FROM spend WHERE month < strftime('%Y-%m', 'now', '-12 months');
CREATE TABLE IF NOT EXISTS spend (
  month TEXT PRIMARY KEY,       -- YYYY-MM
  usd   REAL NOT NULL DEFAULT 0
);

-- Esports Hub v3: personal match journal and server badges (25 Nov 2026, builder C). PURELY ADDITIVE: two new tables and one index, every statement
-- IF NOT EXISTS, so the file is idempotent and safe to apply twice (staging: wrangler d1 execute --file; production: migrations apply).
-- No existing table or column changes. Read only by the v3.journal and v3.achievements routes (both OFF by default) and the daily cron.
--
-- v3_journal_entries: matches a signed-in player logs for themselves. PRIVATE to the owner: never on a public page, never mixed with the verified
-- results (those come only from results an organiser recorded). At most 2000 rows per account (enforced by the insert in journal-repo).
-- played_on is the calendar day the player chose (YYYY-MM-DD), not a timestamp. No contact details, dates of birth, ids, IPs or money columns.
CREATE TABLE IF NOT EXISTS v3_journal_entries (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  played_on TEXT NOT NULL CHECK (length(played_on) = 10 AND played_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  game TEXT NOT NULL CHECK (game IN ('bgmi','free_fire','valorant','cod_mobile','cs2','other')),
  mode TEXT CHECK (mode IS NULL OR length(mode) <= 40),
  map TEXT CHECK (map IS NULL OR length(map) <= 40),
  placement INTEGER CHECK (placement IS NULL OR placement BETWEEN 1 AND 100),
  kills INTEGER NOT NULL CHECK (kills BETWEEN 0 AND 200),
  damage INTEGER CHECK (damage IS NULL OR damage BETWEEN 0 AND 100000),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS v3_journal_entries_user_idx ON v3_journal_entries (user_id, played_on);

-- v3_badge_state: per account and badge, the owner's show/hide choice, and for badges whose source rows are deleted later (scrims are deleted
-- 7 days after they start) the time the server recorded the qualifying action. Every other badge is worked out from live, verified rows on each read
-- (src/v3/lib/badges.ts), so a result removed by a correction or a takedown also removes the badge it gave.
CREATE TABLE IF NOT EXISTS v3_badge_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL CHECK (length(badge_id) BETWEEN 3 AND 40),
  recorded_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, badge_id)
);

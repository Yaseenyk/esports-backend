-- 0B M4: feature flags and kill switches. Expand only: the old Worker ignores the table, an absent row means "default" (authz.mode legacy, everything else off).
-- Keys: authz.mode (legacy|shadow|org), orgs.team, audit.off, shed.tracking, kill.public_forms, kill.directory, kill.team_pages, kill.uploads,
--       kill.mail, kill.tracking, kill.public_writes, admin.enabled, takedown.enforce. The code (src/flags.ts) validates every value.
-- Childless table: a CHECK can be widened later by rebuild (blueprint 16.4). No rows are seeded on purpose.
CREATE TABLE IF NOT EXISTS flags (
  key TEXT PRIMARY KEY CHECK (length(key) <= 48),
  value TEXT NOT NULL CHECK (length(value) <= 200),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

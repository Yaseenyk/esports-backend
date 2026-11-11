-- 0B M7: audit_log (blueprint 7 and 15.2). Expand only: the old Worker ignores the table; flag audit.off makes the helper a no-op.
-- id is INTEGER PRIMARY KEY without AUTOINCREMENT (no sqlite_sequence write): an insert is 2 writes (row + idx_audit_org), the 400-day purge 2 more.
-- No IP, no user agent, no outcome column. actor_id, target_id are ids, never emails, names or tokens. meta is allow-listed by src/audit.ts.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','staff','capability','system')),
  actor_id TEXT NOT NULL DEFAULT '',
  org_id TEXT, event_id TEXT,
  action TEXT NOT NULL CHECK (length(action) <= 40),
  target_type TEXT NOT NULL DEFAULT '' CHECK (length(target_type) <= 24),
  target_id TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '' CHECK (length(reason_code) <= 24),
  meta TEXT NOT NULL DEFAULT '{}' CHECK (length(meta) <= 300)
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, id);

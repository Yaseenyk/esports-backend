-- 0B M5: organisations and their members. Expand only: empty until the backfill (migrations-deferred/0042) and the dual-write Worker fill them.
-- kind is the truth, never inferred from the id. CHECK lists carry every value a later phase needs (organisations is never rebuilt).
-- Rollback is "empty, do not drop" (blueprint 16.4): events.org_id references organisations(id).
CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('personal','team')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending_deletion')),
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS org_members (
  org_id  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  added_by TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

-- Phase 6: read-only API keys. Expand only (a new table; nothing else changes). Rollback is "empty, do not drop".
-- The key itself (ehk_ + 32 random chars) is shown once at creation and never stored: key_hash = base64url(SHA-256(key)), the links.ts pattern.
-- hint is the first 8 characters of the key (ehk_ plus 4), enough for a person to tell their keys apart, useless for guessing (192 random bits remain).
-- scope is fixed to 'read'. Revoking sets revoked_at (the row stays so the audit trail still points at something). last_used_at moves at most once an hour.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  key_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL CHECK (length(hint) <= 12),
  scope TEXT NOT NULL DEFAULT 'read' CHECK (scope = 'read'),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, revoked_at);

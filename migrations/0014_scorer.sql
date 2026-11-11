-- Scorer links: a referee or lobby host enters results from a phone through an unguessable link, no account.
-- Only the SHA-256 of the token is stored. A link has a lifetime, can be scoped to one stage, and can be revoked.
CREATE TABLE scorer_links (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  stage TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_scorer_links_event ON scorer_links(event_id, created_at);

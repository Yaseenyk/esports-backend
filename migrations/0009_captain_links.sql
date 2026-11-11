-- Captain links: one unguessable link per team, shared by the features that talk to captains (result submission, ready-check).
-- Only the SHA-256 of the token is stored. The link is revocable.
CREATE TABLE captain_links (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_captain_links_event ON captain_links(event_id, team);

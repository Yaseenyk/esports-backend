-- Ready-check: a captain taps "we are here and ready" for a match; the organiser sees who is present and decides about forfeits.
CREATE TABLE ready_checks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL,
  team TEXT NOT NULL,
  ready_at TEXT NOT NULL,
  UNIQUE (match_id, team)
);
CREATE INDEX idx_ready_checks_event ON ready_checks(event_id);

CREATE TABLE ready_settings (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  grace_minutes INTEGER NOT NULL DEFAULT 10,
  updated_at TEXT NOT NULL
);

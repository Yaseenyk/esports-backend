-- Tournament registration: one public form per event, and the team registrations that come in through it.
CREATE TABLE registration_forms (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  closes_at TEXT,
  max_teams INTEGER,
  team_size INTEGER NOT NULL DEFAULT 4,
  subs INTEGER NOT NULL DEFAULT 1,
  open INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  captain_name TEXT NOT NULL,
  captain_contact TEXT NOT NULL,
  players TEXT NOT NULL,           -- JSON: [{"name": "...", "ign": "...", "minor": false}]
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_registrations_event ON registrations(event_id, status);

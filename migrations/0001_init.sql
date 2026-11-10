-- Privacy by design: no date of birth, no Aadhaar digits anywhere in this schema.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  game TEXT NOT NULL DEFAULT '',
  organiser TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  emergency TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  signing_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE TABLE teams (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  logo TEXT,
  PRIMARY KEY (event_id, id)
);

CREATE TABLE people (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  zones TEXT NOT NULL DEFAULT '[]',
  minor INTEGER NOT NULL DEFAULT 0,
  guardian INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, id)
);

CREATE TABLE photos (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (event_id, person_id)
);

CREATE TABLE gate_keys (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_gate_keys_event ON gate_keys(event_id);

CREATE TABLE checkins (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (event_id, person_id)
);
CREATE INDEX idx_checkins_at ON checkins(event_id, at);

CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_share_event_person ON share_links(event_id, person_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invites_event ON invites(event_id);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  minor INTEGER NOT NULL DEFAULT 0,
  photo BLOB,
  photo_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_submissions_event ON submissions(event_id, status);

-- Rate limiting: key is a SHA-256 hash of scope + IP (never a raw IP).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

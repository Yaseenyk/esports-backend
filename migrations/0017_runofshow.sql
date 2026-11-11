-- Run of show: the timeline of everything that must happen on event day. Owners are free text (volunteers need no account).
CREATE TABLE runofshow_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL,
  at_time TEXT NOT NULL,                       -- HH:MM, local time of the venue
  day_offset INTEGER NOT NULL DEFAULT 0,       -- 0 = event day, 1 = the day after, and so on
  title TEXT NOT NULL,                         -- <= 100
  owner_name TEXT NOT NULL DEFAULT '',         -- <= 60
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  notes TEXT NOT NULL DEFAULT '',              -- <= 300
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX idx_runofshow_items_event ON runofshow_items(event_id, sort);

-- Optional read-only link for volunteers. Only the SHA-256 of the token is stored; one link per event, revocable.
CREATE TABLE runofshow_links (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  show_notes INTEGER NOT NULL DEFAULT 0,       -- 1 = the public page also shows the notes
  created_at TEXT NOT NULL
);

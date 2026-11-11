-- Public events listing: an organiser opts one event in. Only what is written here is ever shown publicly.
CREATE TABLE directory_entries (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  listed INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 80),
  game TEXT NOT NULL DEFAULT '' CHECK (length(game) <= 40),
  city TEXT NOT NULL DEFAULT '' CHECK (length(city) <= 40),
  mode TEXT NOT NULL DEFAULT 'in-person' CHECK (mode IN ('in-person', 'online', 'hybrid')),
  starts_on TEXT NOT NULL DEFAULT '',
  blurb TEXT NOT NULL DEFAULT '' CHECK (length(blurb) <= 300),
  reg_link TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_directory_listed ON directory_entries(listed, starts_on);

CREATE TABLE directory_reports (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  reporter TEXT NOT NULL,          -- salted hash of the reporter address, so one person counts once; never the address itself
  created_at TEXT NOT NULL
);
CREATE INDEX idx_directory_reports_event ON directory_reports(event_id);

-- Season leaderboard settings: one row per event. The slug is the only thing in the public link (random, 12 base32 characters, never changes).
-- scale is a JSON array of placement points for battle royale; days is a JSON array of {label, fromMatch, toMatch, date?}.
-- The standings themselves are never stored: the public page works them out from the matches and battle royale results of the event.
CREATE TABLE league_settings (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  scale TEXT NOT NULL DEFAULT '[]',
  per_kill REAL NOT NULL DEFAULT 1,
  win_pts REAL NOT NULL DEFAULT 3,
  draw_pts REAL NOT NULL DEFAULT 1,
  loss_pts REAL NOT NULL DEFAULT 0,
  days TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

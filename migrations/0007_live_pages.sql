-- Public live page of an event: one row per event. The slug is the only thing in the public URL (random, 12 base32 characters, never changes).
-- The snapshot is the JSON the organiser published (standings, schedule, announcements, sponsors, ticker); it holds nothing about people or passes.
CREATE TABLE live_pages (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

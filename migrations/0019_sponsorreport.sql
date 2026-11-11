-- Sponsor report counters. Counts only: one number per event, day, place and view. Nothing per visitor is stored
-- (no address, no cookie, no id, no browser details), so there is nothing here that could identify anyone.
CREATE TABLE live_hits (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                                   -- UTC date, YYYY-MM-DD
  source TEXT NOT NULL CHECK (source IN ('live','overlay','embed')),
  view TEXT NOT NULL DEFAULT '' CHECK (length(view) <= 20),
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, day, source, view)
);

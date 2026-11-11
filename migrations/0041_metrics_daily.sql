-- 0B M8: daily aggregate counters (blueprint 8.3). Counts only: no identifier, no timestamp finer than the day. Expand only; flag kill.tracking stops writers.
-- WITHOUT ROWID: the upsert is 1 row written. At most about 60 distinct rows a day. Kept (no personal data).
CREATE TABLE IF NOT EXISTS metrics_daily (
  day TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) <= 24),
  d1 TEXT NOT NULL DEFAULT '' CHECK (length(d1) <= 20),
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, d1)
) WITHOUT ROWID;

-- Match core shared by the feature modules (scorer, results, ready, stages, leaderboard...). Features never write this table directly: they call src/matches.ts.
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'main',
  round INTEGER NOT NULL DEFAULT 1,
  slot INTEGER NOT NULL DEFAULT 1,
  a TEXT NOT NULL DEFAULT '',
  b TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','ready','live','finished','forfeit')),
  score_a INTEGER,
  score_b INTEGER,
  winner TEXT CHECK (winner IN ('a','b','draw')),
  starts_at TEXT,
  next_id TEXT,
  next_side TEXT CHECK (next_side IN ('a','b')),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX idx_matches_event ON matches(event_id, stage, round, slot);

-- Battle royale: one row per team per match.
CREATE TABLE br_results (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  match_no INTEGER NOT NULL,
  team TEXT NOT NULL,
  placement INTEGER NOT NULL,
  kills INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, match_no, team)
);

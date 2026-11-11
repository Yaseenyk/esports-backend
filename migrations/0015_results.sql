-- Captain result submissions: a team captain reports a score (with an optional screenshot) through a captain link; the organiser approves or rejects it.
-- Approving writes the result through the match core (src/matches.ts applyResult); this table never touches matches.
CREATE TABLE result_submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL,
  team TEXT NOT NULL,
  score_a INTEGER NOT NULL,
  score_b INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  proof TEXT CHECK (proof IS NULL OR length(proof) <= 200000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX idx_result_submissions_event ON result_submissions(event_id, status, created_at);
-- One pending submission per team per match: a newer one replaces the old one.
CREATE UNIQUE INDEX idx_result_submissions_pending ON result_submissions(event_id, match_id, team) WHERE status = 'pending';

-- Small per-event settings row for this feature.
CREATE TABLE result_settings (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

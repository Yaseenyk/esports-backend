-- Phase 1 stream R (blueprint 9.2 and 15.2 M11, dev-review-r2 N-12). Expand only: both tables are new and empty; the old Worker ignores them.
-- Immutable ids: a report or takedown targets an ID that never changes (event_id for live, league, registration, event; team_profiles.id for a team page;
-- share_links.id for a pass; captain_links.id for a results link), never a slug or token, so a rename cannot bypass a takedown. Triggers refuse to change them.
-- Privacy: reporter is a salted hash (never a name, address or account); note is at most 200 characters of sanitised text. No personal data of minors is asked for.
-- The directory keeps S4's own tables (directory_reports.resolved_at, directory_entries.held_at); a takedown on 'directory_entry' is the second moderation source.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('team_profile','live_page','league_page','registration_form','event','pass','results')),
  target_id TEXT NOT NULL,
  event_id TEXT, org_id TEXT,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('spam','scam','minor_exposed','contact_details','offensive','copyright','wrong_info','other')),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  reporter TEXT NOT NULL CHECK (length(reporter) <= 64),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed','needs_other_staff')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  created_at TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, decision_code TEXT NOT NULL DEFAULT '',
  lookup_key TEXT NOT NULL DEFAULT '' CHECK (length(lookup_key) <= 64)
);
CREATE INDEX IF NOT EXISTS idx_reports_queue ON reports(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);

CREATE TABLE IF NOT EXISTS takedowns (
  target_type TEXT NOT NULL CHECK (target_type IN ('team_profile','live_page','league_page','registration_form','event','pass','results','directory_entry')),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('hidden','restored')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) <= 24),
  by_staff TEXT NOT NULL,
  at TEXT NOT NULL,
  event_id TEXT, org_id TEXT,
  PRIMARY KEY (target_type, target_id)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS trg_reports_immutable BEFORE UPDATE OF id, target_type, target_id, reporter, created_at ON reports
BEGIN SELECT RAISE(ABORT, 'reports ids are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_takedowns_immutable BEFORE UPDATE OF target_type, target_id ON takedowns
BEGIN SELECT RAISE(ABORT, 'takedown ids are immutable'); END;

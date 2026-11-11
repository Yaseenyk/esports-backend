-- Directory moderation, interim (before the Phase 1 admin).
-- An owner edit used to DELETE the reports against a listing, so a hidden listing came back and the history was lost.
-- Now an edit marks the open reports as resolved (they stay as history), and a listing that was hidden is held until a person restores it.
ALTER TABLE directory_reports ADD COLUMN resolved_at TEXT;
ALTER TABLE directory_entries ADD COLUMN held_at TEXT;

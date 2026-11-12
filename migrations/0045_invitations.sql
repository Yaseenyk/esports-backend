-- Phase 2a-i: invitations to an organisation (role admin or member) or to one event (role editor or viewer). Expand only: nothing reads it until flag orgs.team is on.
-- token_hash is SHA-256 of a 24 byte random token (src/links.ts hashToken); the clear token is shown once to the inviter and never stored.
-- email is personal data: blanked when the invitation is used, and the row is purged 14 days after expiry (src/features/housekeeping.ts purgeExpired).
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  CHECK ((org_id IS NOT NULL) <> (event_id IS NOT NULL)),
  CHECK ((org_id IS NOT NULL AND role IN ('admin','member')) OR (event_id IS NOT NULL AND role IN ('editor','viewer')))
);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invitations_event ON invitations(event_id, created_at);
-- dev-review-r2 3.1 item 4: an admin cannot create two open invitations for one address (organisation and event).
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_org ON invitations(org_id, email) WHERE org_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_event ON invitations(event_id, email) WHERE event_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;

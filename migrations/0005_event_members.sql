-- More than one organiser per event: the owner can give other accounts edit or view access.
CREATE TABLE event_members (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX idx_event_members_user ON event_members(user_id);

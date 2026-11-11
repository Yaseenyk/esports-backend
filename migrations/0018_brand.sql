-- Brand kit: a logo and two colours. scope is 'account' (all of a user's events) or an event id (that event only; an event kit overrides the account kit).
-- Event kits are stored under the event owner, so the owner and editors all edit the same row.
CREATE TABLE brand_kits (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  logo TEXT,
  primary_color TEXT NOT NULL,
  secondary_color TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_user_id, scope)
);
-- An event kit goes away with its event (scope is not a foreign key because it also holds the word 'account').
CREATE TRIGGER brand_kits_event_gone AFTER DELETE ON events BEGIN
  DELETE FROM brand_kits WHERE scope = OLD.id;
END;

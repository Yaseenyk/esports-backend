-- Opt-in public TEAM pages (never player pages). A page is hidden until its owner publishes it with a consent statement; unpublishing clears the consent at once.
CREATE TABLE team_profiles (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0,
  blurb TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  consent_note TEXT,
  consent_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_team_profiles_owner ON team_profiles(owner_user_id);

-- Which team names, in which events, a page covers. Results are computed from matches and br_results at read time.
CREATE TABLE team_profile_events (
  profile_id TEXT NOT NULL REFERENCES team_profiles(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  PRIMARY KEY (profile_id, event_id, team_name)
);
CREATE INDEX idx_team_profile_events_event ON team_profile_events(event_id);

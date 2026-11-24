-- Esports Hub v3, phases 3-5 (24 Nov 2026). PURELY ADDITIVE: new tables and indexes only, every statement IF NOT EXISTS, so the file is
-- idempotent and safe to apply twice (staging: wrangler d1 execute --file; production: migrations apply). No existing table or column changes.
-- Every feature that reads these tables is behind a flag that is OFF by default (v3.profiles, v3.scrims, v3.directory): a Worker that has the code
-- but not the tables answers 404 before any of them is read. No money columns, no dates of birth, no government ids, no IP addresses.

-- ---------------------------------------------------------------- Phase 3: player profiles and team pages
-- Team page privacy on top of the legacy team_profiles row. Effective visibility: team_profiles.published = 0 -> private (whatever this row says);
-- published = 1 -> 'public' when this row says public, otherwise 'unlisted' (link only). The v3 service keeps published in step when it changes this.
CREATE TABLE IF NOT EXISTS v3_team_pages (
  profile_id TEXT PRIMARY KEY NOT NULL REFERENCES team_profiles(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public')),
  public_since INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Entries (one tournament + team) the owner chose to hide from their public player profile or team page. item_key = "<tournament slug>:<team key>".
CREATE TABLE IF NOT EXISTS v3_player_hidden_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (length(item_key) <= 140),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, item_key)
);
CREATE TABLE IF NOT EXISTS v3_team_hidden_items (
  profile_id TEXT NOT NULL REFERENCES team_profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (length(item_key) <= 140),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (profile_id, item_key)
);

-- Reports on a public player profile or team page. target_key = the user id (player) or the team page id (team); never shown to anyone but staff.
-- The reporter is a salted one-way hash of the reporting ACCOUNT (one account counts once), as in lft_reports.
CREATE TABLE IF NOT EXISTS v3_profile_reports (
  id TEXT PRIMARY KEY NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('player','team')),
  target_key TEXT NOT NULL,
  reporter TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS v3_profile_reports_once_uq ON v3_profile_reports (target_kind, target_key, reporter);
CREATE INDEX IF NOT EXISTS v3_profile_reports_reporter_idx ON v3_profile_reports (reporter);

-- Moderation state of a profile or team page: hidden_at set by the 3-reporter auto-hide (only while takedown.enforce is on) or a minor report; cleared by staff.
CREATE TABLE IF NOT EXISTS v3_profile_moderation (
  target_kind TEXT NOT NULL CHECK (target_kind IN ('player','team')),
  target_key TEXT NOT NULL,
  hidden_at INTEGER,
  report_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (target_kind, target_key)
);
CREATE INDEX IF NOT EXISTS v3_profile_moderation_hidden_idx ON v3_profile_moderation (hidden_at) WHERE hidden_at IS NOT NULL;

-- ---------------------------------------------------------------- Phase 4: scrim finder
-- An open scrim slot posted by a captain (the owner of a team page). starts_at is UTC epoch seconds (the site shows IST by default).
-- contact is revealed only to captains whose request was accepted. Slots are deleted 7 days after they start (requests and reports cascade).
CREATE TABLE IF NOT EXISTS scrim_slots (
  id TEXT PRIMARY KEY NOT NULL,
  poster_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_profile_id TEXT NOT NULL REFERENCES team_profiles(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('bgmi','free_fire','valorant','cod_mobile','cs2','other')),
  starts_at INTEGER NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('india','south_asia','asia_pacific','middle_east','europe','americas','other')),
  server TEXT CHECK (server IS NULL OR length(server) <= 40),
  skill_note TEXT CHECK (skill_note IS NULL OR length(skill_note) <= 200),
  slots_total INTEGER NOT NULL CHECK (slots_total BETWEEN 1 AND 24),
  slots_filled INTEGER NOT NULL DEFAULT 0 CHECK (slots_filled >= 0 AND slots_filled <= slots_total),
  contact TEXT NOT NULL CHECK (length(contact) <= 40),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','full','cancelled','removed')),
  hidden_at INTEGER,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS scrim_slots_board_idx ON scrim_slots (status, game, starts_at);
CREATE INDEX IF NOT EXISTS scrim_slots_poster_idx ON scrim_slots (poster_user_id, status);
CREATE INDEX IF NOT EXISTS scrim_slots_starts_idx ON scrim_slots (starts_at);

CREATE TABLE IF NOT EXISTS scrim_requests (
  id TEXT PRIMARY KEY NOT NULL,
  slot_id TEXT NOT NULL REFERENCES scrim_slots(id) ON DELETE CASCADE,
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_profile_id TEXT NOT NULL REFERENCES team_profiles(id) ON DELETE CASCADE,
  message TEXT CHECK (message IS NULL OR length(message) <= 300),
  contact TEXT NOT NULL CHECK (length(contact) <= 40),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','accepted','declined','withdrawn')),
  responded_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS scrim_requests_once_uq ON scrim_requests (slot_id, requester_user_id);
CREATE INDEX IF NOT EXISTS scrim_requests_requester_idx ON scrim_requests (requester_user_id);

CREATE TABLE IF NOT EXISTS scrim_reports (
  id TEXT PRIMARY KEY NOT NULL,
  slot_id TEXT NOT NULL REFERENCES scrim_slots(id) ON DELETE CASCADE,
  reporter TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS scrim_reports_once_uq ON scrim_reports (slot_id, reporter);
CREATE INDEX IF NOT EXISTS scrim_reports_reporter_idx ON scrim_reports (reporter);

-- One account blocking another on the scrim finder. label = the blocked team's name at block time (so the list is readable without user ids).
CREATE TABLE IF NOT EXISTS scrim_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 60),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (blocker_user_id != blocked_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS scrim_blocks_pair_uq ON scrim_blocks (blocker_user_id, blocked_user_id);
CREATE INDEX IF NOT EXISTS scrim_blocks_blocked_idx ON scrim_blocks (blocked_user_id);

-- ---------------------------------------------------------------- Phase 5: public tournament directory
-- The organiser's opt-in to show the team sign-up link (the registration form) on the public directory. Default: no link, the card opens the tournament page.
CREATE TABLE IF NOT EXISTS v3_tournament_directory (
  tournament_id TEXT PRIMARY KEY NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  signup_public INTEGER NOT NULL DEFAULT 0 CHECK (signup_public IN (0,1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- The directory lists upcoming public tournaments by city (case-insensitive) and game; tournaments_status_start_idx already serves status + date.
CREATE INDEX IF NOT EXISTS tournaments_city_idx ON tournaments (lower(city)) WHERE city IS NOT NULL;

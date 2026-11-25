-- Esports Hub v3, builder B (25 Nov 2026): squad availability planner, tournament alerts, LFT team matching.
-- PURELY ADDITIVE: new tables and indexes only, every statement IF NOT EXISTS, so the file is idempotent and safe to apply twice
-- (staging: wrangler d1 execute --file, production: migrations apply). No existing table or column changes (no ALTER TABLE, which SQLite cannot make idempotent).
-- Every feature that reads these tables is behind a flag that is OFF by default (v3.planner, v3.alerts, v3.lft_match).
-- No money columns, no dates of birth, no government ids, no IP addresses, no email addresses (alerts read users.email at send time).

-- ---------------------------------------------------------------- Squad availability planner (flag v3.planner)
-- A plan made by a captain without an account. The share link carries a random token: only its SHA-256 is stored, and so is the captain's delete key.
-- slots = JSON array of UTC epoch-second slot starts (at most 336). Deleted 30 days after creation (votes cascade).
CREATE TABLE IF NOT EXISTS squad_plans (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL CHECK (length(token_hash) BETWEEN 40 AND 64),
  captain_key_hash TEXT NOT NULL CHECK (length(captain_key_hash) BETWEEN 40 AND 64),
  game TEXT NOT NULL CHECK (game IN ('bgmi','free_fire','valorant','cod_mobile','cs2','other')),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 60),
  tz TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 40),
  slot_minutes INTEGER NOT NULL CHECK (slot_minutes IN (30,60)),
  slots TEXT NOT NULL CHECK (length(slots) <= 4000),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS squad_plans_token_uq ON squad_plans (token_hash);
CREATE INDEX IF NOT EXISTS squad_plans_expiry_idx ON squad_plans (expires_at);
-- One teammate's answers. name = a display name only (no account). edit_key_hash = SHA-256 of a random key kept in that browser, so only it can change the row.
-- picks = JSON array of slot indexes the teammate is free for.
CREATE TABLE IF NOT EXISTS squad_plan_votes (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES squad_plans(id) ON DELETE CASCADE,
  edit_key_hash TEXT NOT NULL CHECK (length(edit_key_hash) BETWEEN 40 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 24),
  picks TEXT NOT NULL DEFAULT '[]' CHECK (length(picks) <= 2000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS squad_plan_votes_key_uq ON squad_plan_votes (plan_id, edit_key_hash);

-- ---------------------------------------------------------------- Tournament alerts (flag v3.alerts)
-- One row per account. pending = waiting for the double opt-in click, active = confirmed, stopped = unsubscribed (kept so the link keeps answering).
-- confirm_hash / unsub_hash are SHA-256 of the link tokens. last_digest_day (YYYY-MM-DD, UTC) = the last day the daily digest ran for this person, so at most one email per person per day.
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','stopped')),
  confirm_hash TEXT CHECK (confirm_hash IS NULL OR length(confirm_hash) BETWEEN 40 AND 64),
  confirm_expires_at INTEGER,
  confirmed_at INTEGER,
  unsub_hash TEXT NOT NULL CHECK (length(unsub_hash) BETWEEN 40 AND 64),
  last_digest_day TEXT CHECK (last_digest_day IS NULL OR length(last_digest_day) = 10),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_subscriptions_unsub_uq ON alert_subscriptions (unsub_hash);
CREATE INDEX IF NOT EXISTS alert_subscriptions_confirm_idx ON alert_subscriptions (confirm_hash) WHERE confirm_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS alert_subscriptions_due_idx ON alert_subscriptions (status, last_digest_day);
-- What to be told about: a game (or any), a place ('any', 'online' or a lower-case city) and a kind (any, tournament, college calendar event). At most 5 per account.
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('any','bgmi','free_fire','valorant','cod_mobile','cs2','other')),
  place TEXT NOT NULL CHECK (length(place) BETWEEN 2 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('any','tournament','college')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_rules_user_idx ON alert_rules (user_id);
-- Items already sent to an account, so the same tournament is never emailed twice. item_key = 't:<tournament id>' or 'c:<calendar entry id>'.
CREATE TABLE IF NOT EXISTS alert_sent_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (length(item_key) <= 80),
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_key)
);
CREATE INDEX IF NOT EXISTS alert_sent_items_age_idx ON alert_sent_items (sent_at);
-- The alerts' own daily email cap (well under the free Resend plan), counted on top of the shared mail_budget pool. capped_at = when the cap was hit (logged once).
CREATE TABLE IF NOT EXISTS alert_day_budget (
  day TEXT PRIMARY KEY NOT NULL CHECK (length(day) = 10),
  sent INTEGER NOT NULL DEFAULT 0,
  capped_at INTEGER
);

-- ---------------------------------------------------------------- LFT team matching (flag v3.lft_match)
-- Extra facts of a listing: languages and play-hour blocks (JSON arrays of fixed codes) and the contacts the poster chose to share after an accept (JSON object kind -> handle).
CREATE TABLE IF NOT EXISTS lft_listing_prefs (
  listing_id TEXT PRIMARY KEY NOT NULL REFERENCES lft_listings(id) ON DELETE CASCADE,
  languages TEXT NOT NULL DEFAULT '[]' CHECK (length(languages) <= 200),
  play_hours TEXT NOT NULL DEFAULT '[]' CHECK (length(play_hours) <= 200),
  contacts TEXT NOT NULL DEFAULT '{}' CHECK (length(contacts) <= 400)
);
-- The contacts the applicant chose to share with this one listing (revealed to the poster only after an accept).
CREATE TABLE IF NOT EXISTS lft_application_contacts (
  application_id TEXT PRIMARY KEY NOT NULL REFERENCES lft_applications(id) ON DELETE CASCADE,
  contacts TEXT NOT NULL DEFAULT '{}' CHECK (length(contacts) <= 400)
);
-- One account blocking another on the board. label = a readable name at block time (team name or "Player"), so the list needs no user ids.
CREATE TABLE IF NOT EXISTS lft_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 60),
  created_at INTEGER NOT NULL,
  CHECK (blocker_user_id != blocked_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS lft_blocks_pair_uq ON lft_blocks (blocker_user_id, blocked_user_id);
CREATE INDEX IF NOT EXISTS lft_blocks_blocked_idx ON lft_blocks (blocked_user_id);
-- Reports on a request to join. The reporter is a salted one-way hash of the reporting ACCOUNT (one account counts once), as in lft_reports.
CREATE TABLE IF NOT EXISTS lft_application_reports (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL REFERENCES lft_applications(id) ON DELETE CASCADE,
  reporter TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (length(reason_code) <= 24),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lft_application_reports_once_uq ON lft_application_reports (application_id, reporter);
CREATE INDEX IF NOT EXISTS lft_application_reports_age_idx ON lft_application_reports (created_at);

-- Esports Hub v3, phase 4b: the scrim MANAGER on top of the scrim finder (24 Nov 2026). PURELY ADDITIVE and idempotent: new tables and indexes
-- only, every statement IF NOT EXISTS, no ALTER, no data change. Read only behind flag v3.scrims (OFF by default). Needs 0056.

-- Who is in which slot of a scrim: one row per accepted request, slot numbers 1..slots_total, the lowest free number first.
CREATE TABLE IF NOT EXISTS scrim_slot_assignments (
  slot_id TEXT NOT NULL REFERENCES scrim_slots(id) ON DELETE CASCADE,
  slot_no INTEGER NOT NULL CHECK (slot_no BETWEEN 1 AND 24),
  request_id TEXT NOT NULL REFERENCES scrim_requests(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (slot_id, slot_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS scrim_slot_assignments_request_uq ON scrim_slot_assignments (request_id);

-- The waitlist of a full scrim. When a confirmed team drops, the next waiting team gets an OFFER (status offered) that it must accept before
-- offer_expires_at; an unanswered offer expires and passes to the next team.
CREATE TABLE IF NOT EXISTS scrim_waitlist (
  id TEXT PRIMARY KEY NOT NULL,
  slot_id TEXT NOT NULL REFERENCES scrim_slots(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES scrim_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','accepted','declined','expired','left','removed')),
  offered_at INTEGER,
  offer_expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS scrim_waitlist_request_uq ON scrim_waitlist (request_id);
CREATE INDEX IF NOT EXISTS scrim_waitlist_slot_idx ON scrim_waitlist (slot_id, status, created_at);
CREATE INDEX IF NOT EXISTS scrim_waitlist_offer_idx ON scrim_waitlist (status, offer_expires_at);

-- In-platform notices (no email, no push): a waitlist offer, an expired offer, a team removed from a scrim. Deleted with the scrim or the account.
CREATE TABLE IF NOT EXISTS scrim_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('waitlist_offer','offer_expired','removed_from_scrim')),
  slot_id TEXT REFERENCES scrim_slots(id) ON DELETE CASCADE,
  read_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS scrim_notifications_user_idx ON scrim_notifications (user_id, created_at);

-- Recurring daily scrims: a template that creates one slot per day, days_ahead days ahead, at time_of_day in India time (IST, "HH:MM").
CREATE TABLE IF NOT EXISTS scrim_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  poster_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_profile_id TEXT NOT NULL REFERENCES team_profiles(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('bgmi','free_fire','valorant','cod_mobile','cs2','other')),
  time_of_day TEXT NOT NULL CHECK (length(time_of_day) = 5),
  days_ahead INTEGER NOT NULL CHECK (days_ahead BETWEEN 1 AND 7),
  region TEXT NOT NULL CHECK (region IN ('india','south_asia','asia_pacific','middle_east','europe','americas','other')),
  server TEXT CHECK (server IS NULL OR length(server) <= 40),
  skill_note TEXT CHECK (skill_note IS NULL OR length(skill_note) <= 200),
  slots_total INTEGER NOT NULL CHECK (slots_total BETWEEN 1 AND 24),
  contact TEXT NOT NULL CHECK (length(contact) <= 40),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS scrim_schedules_poster_idx ON scrim_schedules (poster_user_id);
CREATE INDEX IF NOT EXISTS scrim_schedules_active_idx ON scrim_schedules (active, updated_at);

-- One row per schedule day ("YYYY-MM-DD", India date): the slot made for it, or skipped = 1 when the poster cancelled that day (never re-created).
CREATE TABLE IF NOT EXISTS scrim_schedule_days (
  schedule_id TEXT NOT NULL REFERENCES scrim_schedules(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  slot_id TEXT REFERENCES scrim_slots(id) ON DELETE SET NULL,
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0,1)),
  PRIMARY KEY (schedule_id, day)
);
CREATE UNIQUE INDEX IF NOT EXISTS scrim_schedule_days_slot_uq ON scrim_schedule_days (slot_id) WHERE slot_id IS NOT NULL;

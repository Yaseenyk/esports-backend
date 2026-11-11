-- Email reminders and result emails. Opt-in only: a captain is emailed only with an address AND a recorded consent.

-- Consent captured by the public registration form (all optional, additive).
ALTER TABLE registrations ADD COLUMN captain_email TEXT;
ALTER TABLE registrations ADD COLUMN email_consent_text TEXT;
ALTER TABLE registrations ADD COLUMN email_consent_at TEXT;

CREATE TABLE reminder_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tomorrow', 'closing', 'results', 'custom')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'both' CHECK (audience IN ('organiser', 'captain', 'both')),
  send_at TEXT NOT NULL,
  -- 'sending' = claimed by the sender and being delivered in small batches.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  recipients_snapshot_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_reminder_jobs_event ON reminder_jobs(event_id, created_at);
CREATE INDEX idx_reminder_jobs_due ON reminder_jobs(status, send_at);

CREATE TABLE reminder_recipients (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organiser', 'captain')),
  consent_at TEXT,
  unsubscribed_at TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  UNIQUE (event_id, email, kind)
);

-- One row per email actually attempted: the primary key is what makes a double send impossible.
CREATE TABLE reminder_deliveries (
  job_id TEXT NOT NULL REFERENCES reminder_jobs(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  PRIMARY KEY (job_id, recipient_id)
);
CREATE INDEX idx_reminder_deliveries_day ON reminder_deliveries(event_id, day);

-- Global number of emails sent per UTC day (the free Resend plan allows about 100 a day).
CREATE TABLE mail_budget (
  day TEXT PRIMARY KEY,
  sent INTEGER NOT NULL DEFAULT 0
);

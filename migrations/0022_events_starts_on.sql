-- S3: a real date for events. events.date stays free text (max 40 characters, shown as typed);
-- starts_on is the ISO day (YYYY-MM-DD) derived from it, NULL when it cannot be read. Nullable, no default.
-- Existing rows are filled by scripts/backfill-starts-on.mjs (a script, not a migration).
ALTER TABLE events ADD COLUMN starts_on TEXT;

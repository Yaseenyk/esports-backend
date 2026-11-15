-- Esports Hub v3: three nullable columns on users (existing accounts are NOT blocked; NULL means "not given yet").
--  adult_confirmed_at  epoch seconds of the 18+ confirmation (required to post or apply on the LFT board, and for a public profile)
--  resume_consent_at   epoch seconds of the consent to a public Esports Resume (withdrawing sets it back to NULL)
--  discord_user_id     filled by the later Discord stage
-- ALTER TABLE ADD COLUMN is not idempotent in SQLite: apply this file once per database.
ALTER TABLE users ADD COLUMN adult_confirmed_at INTEGER;
ALTER TABLE users ADD COLUMN resume_consent_at INTEGER;
ALTER TABLE users ADD COLUMN discord_user_id TEXT;

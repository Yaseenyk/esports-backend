-- Esports Hub v3, second batch of additive changes (all behind v3 flags that are OFF by default; a Worker can be deployed before this is applied).
--  tournaments.seo_ready_at  epoch seconds of the FIRST time a tournament page became indexable. The weekly cap on newly indexable pages counts this DATE
--                            (not the boolean seo_ready). NULL = never released through the cap.
--  organisations.slug        public URL part of a college / organisation page (lower-case a-z 0-9 and hyphens, set by staff together with verified_at).
--  organisations.verified_at epoch seconds, set by staff after checking the organisation is real. A public college page needs it AND one real tournament.
-- ALTER TABLE ADD COLUMN is not idempotent in SQLite: apply this file ONCE per database (staging: wrangler d1 execute --file, never "migrations apply").
-- The backfill and the index below are safe to repeat. Rollback is "leave the columns, turn the flag off".
ALTER TABLE tournaments ADD COLUMN seo_ready_at INTEGER;
ALTER TABLE organisations ADD COLUMN slug TEXT;
ALTER TABLE organisations ADD COLUMN verified_at INTEGER;

-- Pages that were already indexable keep their release date (their last update is the best date we have), so the cap window sees them.
UPDATE tournaments SET seo_ready_at = updated_at WHERE seo_ready = 1 AND seo_ready_at IS NULL;

CREATE INDEX IF NOT EXISTS tournaments_seo_ready_at_idx ON tournaments (seo_ready_at) WHERE seo_ready_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organisations_slug_uq ON organisations (slug) WHERE slug IS NOT NULL;

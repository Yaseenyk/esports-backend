-- S7 phase A: link tokens are looked up by SHA-256 (see src/links.ts). Nullable until the backfill has filled legacy rows.
ALTER TABLE share_links ADD COLUMN token_hash TEXT;

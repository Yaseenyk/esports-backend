-- ===========================================================================
-- DO NOT APPLY. NOT PART OF THE MIGRATION LEDGER. THE OWNER SCHEDULES THIS.
-- S7 phase B: overwrite the clear link tokens. Kept OUTSIDE migrations/ on purpose so that
-- `wrangler d1 migrations apply` and the test runner never pick it up.
--
-- Preconditions (all of them):
--   1. Phase A has been live and stable for at least 7 days (dev-review-r2 N-2).
--   2. The backfill is finished: all three counts below are 0.
--        SELECT COUNT(*) FROM share_links WHERE token_hash IS NULL OR token_enc IS NULL;
--        SELECT COUNT(*) FROM invites WHERE token_hash IS NULL OR token_enc IS NULL;
--        SELECT COUNT(*) FROM registration_forms WHERE token_hash IS NULL OR token_enc IS NULL;
--   3. LINK_KEY is backed up. A D1 Time Travel bookmark is taken first.
--
-- ONE-WAY STEP. After this runs, a rollback to a Worker older than phase A is FORBIDDEN:
-- those versions look links up by the `token` column, and every issued pass, invite and
-- registration link would answer 404.
--
-- The UPDATEs touch only rows that already carry both new columns, so they cannot destroy a
-- token that has no recoverable copy. Idempotent.
-- ===========================================================================
UPDATE share_links SET token = 'x-' || id WHERE token_hash IS NOT NULL AND token_enc IS NOT NULL AND token <> 'x-' || id;
UPDATE invites SET token = 'x-' || id WHERE token_hash IS NOT NULL AND token_enc IS NOT NULL AND token <> 'x-' || id;
UPDATE registration_forms SET token = 'x-' || event_id WHERE token_hash IS NOT NULL AND token_enc IS NOT NULL AND token <> 'x-' || event_id;

-- Invariant after B (each must return 0). Use <>, not NOT LIKE 'x-%': a random token can legitimately start with "x-", and LIKE is case-insensitive.
-- SELECT COUNT(*) FROM share_links WHERE token <> 'x-' || id;
-- SELECT COUNT(*) FROM invites WHERE token <> 'x-' || id;
-- SELECT COUNT(*) FROM registration_forms WHERE token <> 'x-' || event_id;

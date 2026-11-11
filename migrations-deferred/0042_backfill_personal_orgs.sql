-- ===========================================================================
-- DO NOT APPLY AS A NORMAL MIGRATION. DATA STEP, GATED BY docs/ecosystem/runbook-cutover.md (blueprint 16.3 step 5).
-- Kept OUTSIDE migrations/ so `wrangler d1 migrations apply` and the normal test runner never pick it up (same rule as the S7 phase B file).
-- The migration project (vitest.migrations.config.ts) applies it to rehearsal databases only.
--
-- Run only when ALL of these are true:
--   1. Migrations 0035 to 0039 are applied and the dual-write Worker has served 100 percent of traffic for 10 minutes (no old-style insert can remain).
--   2. A Time Travel bookmark and a sanitised export exist, the bookmark id is recorded.
--   3. Quiet time: just after 00:00 UTC on a day with no event, the predicted rows (node --experimental-strip-types scripts/pair-compare.ts <export>)
--      are under 30 percent of the daily write cap, otherwise split over two days.
-- Run it:  npx wrangler d1 execute esports-db --remote --file migrations-deferred/0042_backfill_personal_orgs.sql
--   (staging first: --env staging with the staging database name). Re-run the file until the last statement reports 0 changes.
--
-- Idempotent: every statement is INSERT OR IGNORE or touches only rows with org_id IS NULL. Re-running changes no count.
-- Caution (dev-review-r2 B-20): OR IGNORE also swallows NOT NULL and CHECK failures, not only UNIQUE. users.name is NOT NULL and at most
-- 60 + 12 characters here, inside the 80 CHECK, so no user can be skipped silently, invariant 1 (first query of test/migrations/invariants.sql) is the gate.
-- Rollback (reversible until the first team organisation gains a second member):
--   UPDATE events SET org_id = NULL, then DELETE FROM org_members, then DELETE FROM organisations (keep the tables, the column and the index)
-- Cost: about 3 rows written per user and 3 per event (index entries counted).
-- ===========================================================================
INSERT OR IGNORE INTO organisations (id, name, kind, status, created_at)
SELECT 'org-' || u.id, substr(u.name, 1, 60) || '''s workspace', 'personal', 'active', u.created_at FROM users u;

INSERT OR IGNORE INTO org_members (org_id, user_id, role, added_by, added_at)
SELECT 'org-' || u.id, u.id, 'admin', u.id, u.created_at FROM users u;

-- Chunked: each statement touches at most 1000 events (the NULL branch of idx_events_org finds them without a scan), so none nears the 30 s limit.
-- Ten chunks cover 10,000 events, the last statement reporting 0 changes means done. A larger database: run the file again.
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);
UPDATE events SET org_id = 'org-' || owner_id, created_by = owner_id WHERE id IN (SELECT id FROM events WHERE org_id IS NULL LIMIT 1000);

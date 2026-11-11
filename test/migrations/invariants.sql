-- The six invariants of blueprint 15.2. Every query must return 0 (the gate for the next cut-over step; src/features/housekeeping.ts runs 1 to 5 daily).
-- 1 every user has a personal organisation with an admin membership
SELECT COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = 'org-' || u.id AND m.user_id = u.id AND m.role = 'admin');
-- 2 no event without an organisation
SELECT COUNT(*) FROM events WHERE org_id IS NULL;
-- 3 a personal-organisation event has its creator as a member
SELECT COUNT(*) FROM events e WHERE e.org_id = 'org-' || e.owner_id AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = e.org_id AND m.user_id = e.owner_id);
-- 4 no orphan personal organisations (left by deleted users)
SELECT COUNT(*) FROM organisations o WHERE o.kind = 'personal' AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id);
-- 5 every event points at an organisation that exists
SELECT COUNT(*) FROM events e WHERE e.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.id = e.org_id);
-- 6 run through wrangler d1 execute, never inside a migration; the result must be empty
PRAGMA foreign_key_check;

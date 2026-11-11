-- 0B M6 (3 of 3): serves the organisation listing and the "org_id IS NULL" branch the chunked backfill uses (about 1 row written per existing event, once).
CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id, created_at);

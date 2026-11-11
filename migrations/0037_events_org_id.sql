-- 0B M6 (1 of 3): events.org_id. NULL means "not yet filled" (an old Worker during a deploy overlap writes NULL, the access code tolerates it).
-- No ON DELETE action, and the column can never be dropped (it carries a foreign key). One ALTER per file: an ALTER cannot be made idempotent.
ALTER TABLE events ADD COLUMN org_id TEXT REFERENCES organisations(id);

-- S6: account state. users can never be rebuilt, so the CHECK lists every value now (pending_deletion is for Phase 3).
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending_deletion'));

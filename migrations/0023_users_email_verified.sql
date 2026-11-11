-- S6: lazy email verification. NULL = not verified yet. Existing accounts stay NULL and are never locked out:
-- nothing requires verification until invitations are accepted (Phase 2a), where they are asked once.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

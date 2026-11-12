-- Email verification for new password sign-ups. verify_required = 1 means "this account must confirm its email before it can create online events".
-- Existing accounts stay 0 and are never locked out. New accounts get 1 only while flag auth.verify_required is on (src/routes/auth.ts).
ALTER TABLE users ADD COLUMN verify_required INTEGER NOT NULL DEFAULT 0;

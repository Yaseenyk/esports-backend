-- Phase 1 stream S (blueprint 15.3, M10): platform staff, kept apart from ordinary users. Expand only: nothing reads it until flag admin.enabled is on.
-- Rows are created ONLY by scripts/create-staff.mjs (SQL run with wrangler); there is no signup route and no staff UI that creates staff.
-- totp_secret_enc is the AES-GCM sealed seed (src/admin/totp.ts, key TOTP_KEK). totp_enabled_at stays NULL until the first valid code.
-- totp_last_step: a code whose time step is <= this value is refused (replay). token_valid_after: staff tokens issued at or before it are refused.
-- role has one value today; a second role is a rebuild of this childless table (blueprint 15.3). Rollback is "empty, do not drop".
CREATE TABLE IF NOT EXISTS platform_staff (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin')),
  totp_secret_enc TEXT,
  totp_enabled_at TEXT,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  token_valid_after INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_at TEXT
) WITHOUT ROWID;

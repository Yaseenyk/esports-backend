-- Phase 7: plans and entitlements, designed in. Expand only. NO payments, no provider, no prices: there is one plan, 'free', and nobody is charged.
-- limits is JSON. The numbers are the documented Cloudflare free-tier figures from docs/ecosystem/limits-verified.md (read 12 Nov 2026), shared by the whole
-- platform (not per account), plus the two caps this code enforces. entitlements has no rows today: absence of a row means the free plan (src/plans.ts).
-- subject is 'user:<id>' or 'org:<id>'. Rollback is "empty, do not drop".
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  limits TEXT NOT NULL CHECK (json_valid(limits))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS entitlements (
  subject TEXT PRIMARY KEY CHECK (subject LIKE 'user:%' OR subject LIKE 'org:%'),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  since TEXT NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO plans (id, name, limits) VALUES ('free', 'Free', '{"apiKeysMax":5,"analyticsWindowMonthsMax":12,"platform":{"d1RowsReadPerDay":5000000,"d1RowsWrittenPerDay":100000,"workersRequestsPerDay":100000,"d1StorageBytes":5000000000}}');

import type { Env } from "../types";
import { purgeAudit } from "../audit"; // stream A (additive)

/**
 * Daily housekeeping for the ownership foundation (blueprint 7.3, 15.2, 16.3; dev-review-r2 N-4). Called once a day from the 03:00 UTC cron tick.
 *
 *  1. invariants     - the five SQL invariants of blueprint 15.2 (each must be 0). Read only. A non-zero count is logged as one JSON line and, best effort,
 *                      counted in metrics_daily (name 'invariant_violation', d1 = 'inv1'..'inv5') so the 48-hour gate does not depend on a log search.
 *                      The sixth invariant, PRAGMA foreign_key_check, is deliberately NOT run here: it scans every child table and would spend the free-tier
 *                      read budget every day; the runbook runs it through wrangler d1 execute at the gates.
 *  2. purge_orphan_orgs - deletes personal organisations that have no member and no event (left by deleted users; E1 deletes the normal case). At most 100 a run.
 *                      An orphan that still has events is left alone and shows up in invariant 4 (the foreign key would refuse the delete anyway).
 *  3. token expiry   - email_tokens and password_resets one day after expiry, invitations when accepted or revoked and 14 days after expiry (personal data: the
 *                      invited email). At most 500 rows per table per run, so a quiet day costs a handful of reads.
 *
 * Every step is independent and never throws: a missing table (migration not applied yet, invitations before Phase 2a) is a skipped step.
 * Nothing here depends on a flag: with every flag off it reads a few tables and deletes only rows that are already dead. Constant SQL only.
 */

export const INVARIANTS: readonly { id: string; stmt: (db: D1Database) => D1PreparedStatement }[] = [
  { id: "inv1", stmt: (db) => db.prepare("SELECT COUNT(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = 'org-' || u.id AND m.user_id = u.id AND m.role = 'admin')") },
  { id: "inv2", stmt: (db) => db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id IS NULL") },
  { id: "inv3", stmt: (db) => db.prepare("SELECT COUNT(*) AS n FROM events e WHERE e.org_id = 'org-' || e.owner_id AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = e.org_id AND m.user_id = e.owner_id)") },
  { id: "inv4", stmt: (db) => db.prepare("SELECT COUNT(*) AS n FROM organisations o WHERE o.kind = 'personal' AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id)") },
  { id: "inv5", stmt: (db) => db.prepare("SELECT COUNT(*) AS n FROM events e WHERE e.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.id = e.org_id)") },
];

export interface InvariantReport {
  /** Count per invariant id; null when the query could not run (tables missing). */
  counts: Record<string, number | null>;
  ok: boolean;
}

export async function checkInvariants(db: D1Database): Promise<InvariantReport> {
  const counts: Record<string, number | null> = {};
  let ok = true;
  for (const inv of INVARIANTS) {
    try {
      const r = await inv.stmt(db).first<{ n: number }>();
      counts[inv.id] = r?.n ?? 0;
      if ((r?.n ?? 0) !== 0) ok = false;
    } catch {
      counts[inv.id] = null; // schema not there yet: not a violation, but not a pass either
    }
  }
  return { counts, ok };
}

/** Deletes up to 100 personal organisations nobody belongs to and no event uses. Returns the number deleted. */
export async function purgeOrphanOrgs(db: D1Database): Promise<number> {
  const r = await db
    .prepare(
      "DELETE FROM organisations WHERE id IN (SELECT o.id FROM organisations o WHERE o.kind = 'personal' AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id) AND NOT EXISTS (SELECT 1 FROM events e WHERE e.org_id = o.id) LIMIT 100)",
    )
    .run();
  return r.meta.changes ?? 0;
}

const DAY_MS = 86_400_000;

export interface ExpiryReport {
  email_tokens: number | null;
  password_resets: number | null;
  invitations: number | null;
}

/** Deletes dead one-time tokens and spent invitations, at most 500 rows per table. null = table not present. */
export async function purgeExpired(db: D1Database, nowMs: number = Date.now()): Promise<ExpiryReport> {
  const dayAgo = new Date(nowMs - DAY_MS).toISOString();
  const fortnightAgo = new Date(nowMs - 14 * DAY_MS).toISOString();
  const run = async (stmt: () => D1PreparedStatement): Promise<number | null> => {
    try {
      return (await stmt().run()).meta.changes ?? 0;
    } catch {
      return null;
    }
  };
  return {
    email_tokens: await run(() => db.prepare("DELETE FROM email_tokens WHERE id IN (SELECT id FROM email_tokens WHERE expires_at < ?1 LIMIT 500)").bind(dayAgo)),
    password_resets: await run(() => db.prepare("DELETE FROM password_resets WHERE id IN (SELECT id FROM password_resets WHERE expires_at < ?1 LIMIT 500)").bind(dayAgo)),
    invitations: await run(() =>
      db.prepare("DELETE FROM invitations WHERE id IN (SELECT id FROM invitations WHERE accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < ?1 LIMIT 500)").bind(fortnightAgo),
    ),
  };
}

export interface HousekeepingReport {
  invariants: InvariantReport;
  purgedOrphanOrgs: number | null;
  expired: ExpiryReport;
}

/** Best effort: one metrics row per violated invariant. Fails silently when metrics_daily does not exist yet. */
async function countViolations(db: D1Database, nowMs: number, rep: InvariantReport): Promise<void> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  for (const [id, n] of Object.entries(rep.counts)) {
    if (!n) continue;
    try {
      await db
        .prepare("INSERT INTO metrics_daily (day, name, d1, n) VALUES (?1, 'invariant_violation', ?2, ?3) ON CONFLICT (day, name, d1) DO UPDATE SET n = excluded.n")
        .bind(day, id, n)
        .run();
    } catch {
      /* no metrics table yet */
    }
  }
}

export async function runHousekeeping(db: D1Database, nowMs: number = Date.now()): Promise<HousekeepingReport> {
  // Purge first, so that an orphan organisation left by a deleted user does not show up as a violation the same morning.
  let purgedOrphanOrgs: number | null = null;
  try {
    purgedOrphanOrgs = await purgeOrphanOrgs(db);
  } catch {
    console.error("housekeeping: purge_orphan_orgs failed");
  }
  const expired = await purgeExpired(db, nowMs);
  const invariants = await checkInvariants(db);
  if (!invariants.ok) {
    console.warn(JSON.stringify({ housekeeping: "invariant_violation", counts: invariants.counts }));
    await countViolations(db, nowMs, invariants);
  }
  return { invariants, purgedOrphanOrgs, expired };
}

/** The one call the cron makes (src/features/reminders-cron.ts). Never throws. */
export async function dailyHousekeeping(env: Env, nowMs: number): Promise<void> {
  try {
    await runHousekeeping(env.DB, nowMs);
  } catch {
    console.error("housekeeping failed");
  }
  // stream A (additive): audit_log retention, 400 days, guarded by one oldest-row read, at most 4 x 500 rows. Never throws.
  try {
    await purgeAudit(env.DB, nowMs);
  } catch {
    console.error("audit purge failed");
  }
}

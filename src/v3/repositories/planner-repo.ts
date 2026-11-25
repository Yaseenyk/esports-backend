/** squad_plans, squad_plan_votes (migration 0090). The only place these tables are queried. A repository decides nothing about who may see a row. */

export interface PlanRow {
  id: string; game: string; title: string; tz: string; slot_minutes: number; slots: string; expires_at: number; created_at: number;
}
export interface VoteRow { id: string; name: string; picks: string; updated_at: number }

export async function plannerTablesExist(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('squad_plans','squad_plan_votes')").first<{ n: number }>();
  return (r?.n ?? 0) === 2;
}

export async function insertPlan(db: D1Database, p: { id: string; tokenHash: string; captainKeyHash: string; game: string; title: string; tz: string; slotMinutes: number; slots: string; expiresAt: number; at: number }): Promise<void> {
  await db
    .prepare("INSERT INTO squad_plans (id, token_hash, captain_key_hash, game, title, tz, slot_minutes, slots, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)")
    .bind(p.id, p.tokenHash, p.captainKeyHash, p.game, p.title, p.tz, p.slotMinutes, p.slots, p.expiresAt, p.at)
    .run();
}

/** A plan by the hash of its share token, only while it has not expired. */
export async function findLivePlan(db: D1Database, tokenHash: string, now: number): Promise<PlanRow | null> {
  return (
    (await db
      .prepare("SELECT id, game, title, tz, slot_minutes, slots, expires_at, created_at FROM squad_plans WHERE token_hash = ?1 AND expires_at > ?2")
      .bind(tokenHash, now)
      .first<PlanRow>()) ?? null
  );
}

export async function listVotes(db: D1Database, planId: string): Promise<VoteRow[]> {
  const r = await db.prepare("SELECT id, name, picks, updated_at FROM squad_plan_votes WHERE plan_id = ?1 ORDER BY created_at, rowid LIMIT 50").bind(planId).all<VoteRow>();
  return r.results;
}

/**
 * Inserts or updates one teammate's answers, keyed by (plan, hash of the browser's edit key). A NEW row lands only while the plan has fewer than `cap`
 * teammates (one statement, so two parallel first votes cannot both pass the cap). Returns "updated", "inserted" or "full".
 */
export async function upsertVote(db: D1Database, v: { id: string; planId: string; editKeyHash: string; name: string; picks: string; at: number }, cap: number): Promise<"updated" | "inserted" | "full"> {
  const up = await db.prepare("UPDATE squad_plan_votes SET name = ?3, picks = ?4, updated_at = ?5 WHERE plan_id = ?1 AND edit_key_hash = ?2").bind(v.planId, v.editKeyHash, v.name, v.picks, v.at).run();
  if ((up.meta?.changes ?? 0) === 1) return "updated";
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO squad_plan_votes (id, plan_id, edit_key_hash, name, picks, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 WHERE (SELECT COUNT(*) FROM squad_plan_votes WHERE plan_id = ?2) < ?7`,
    )
    .bind(v.id, v.planId, v.editKeyHash, v.name, v.picks, v.at, cap)
    .run();
  if ((ins.meta?.changes ?? 0) === 1) return "inserted";
  // A parallel request with the same key may have inserted first: try the update once more before saying "full".
  const again = await db.prepare("UPDATE squad_plan_votes SET name = ?3, picks = ?4, updated_at = ?5 WHERE plan_id = ?1 AND edit_key_hash = ?2").bind(v.planId, v.editKeyHash, v.name, v.picks, v.at).run();
  return (again.meta?.changes ?? 0) === 1 ? "updated" : "full";
}

/** The id of the row an edit key owns (so the browser can find its own answers in the list). */
export async function voteIdByKey(db: D1Database, planId: string, editKeyHash: string): Promise<string | null> {
  return (await db.prepare("SELECT id FROM squad_plan_votes WHERE plan_id = ?1 AND edit_key_hash = ?2").bind(planId, editKeyHash).first<{ id: string }>())?.id ?? null;
}

export async function deleteVote(db: D1Database, planId: string, editKeyHash: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM squad_plan_votes WHERE plan_id = ?1 AND edit_key_hash = ?2").bind(planId, editKeyHash).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** Deletes a plan (votes cascade) only when BOTH the share token hash and the captain key hash match. */
export async function deletePlanByKeys(db: D1Database, tokenHash: string, captainKeyHash: string): Promise<boolean> {
  const res = await db.batch([
    db.prepare("DELETE FROM squad_plan_votes WHERE plan_id IN (SELECT id FROM squad_plans WHERE token_hash = ?1 AND captain_key_hash = ?2)").bind(tokenHash, captainKeyHash),
    db.prepare("DELETE FROM squad_plans WHERE token_hash = ?1 AND captain_key_hash = ?2").bind(tokenHash, captainKeyHash),
  ]);
  return (res[1]?.meta.changes ?? 0) === 1;
}

/** Retention: deletes plans past their expiry, and their votes. At most 500 plans per run. */
export async function deleteExpiredPlans(db: D1Database, now: number): Promise<number> {
  const res = await db.batch([
    db.prepare("DELETE FROM squad_plan_votes WHERE plan_id IN (SELECT id FROM squad_plans WHERE expires_at <= ?1 LIMIT 500)").bind(now),
    db.prepare("DELETE FROM squad_plans WHERE id IN (SELECT id FROM squad_plans WHERE expires_at <= ?1 LIMIT 500)").bind(now),
  ]);
  return res[1]?.meta.changes ?? 0;
}

/** Table-existence probe, account-deletion statements and nothing else: the SQL behind account-service and retention-service. */

/** True when the v3 tables exist in this database (one sqlite_master read). Lets deletion and the cron work before migration 0051 is applied. */
export async function v3TablesExist(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'player_profiles'").first();
  return r !== null;
}

/** Statements that run BEFORE `DELETE FROM users` in the same batch. See services/account-service.ts for the rules. */
export function accountDeletionStatements(db: D1Database, userId: string, at: number, reporterKey: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM dispute_evidence_blobs WHERE evidence_id IN (SELECT id FROM dispute_evidence WHERE uploaded_by_user_id = ?1)").bind(userId),
    db.prepare("UPDATE dispute_evidence SET purged_at = COALESCE(purged_at, ?2), caption = NULL WHERE uploaded_by_user_id = ?1").bind(userId, at),
    // The append-only trigger allows exactly two changes: actor_user_id to NULL and note to '[deleted]'.
    db.prepare("UPDATE dispute_events SET note = '[deleted]' WHERE actor_user_id = ?1 AND note IS NOT NULL").bind(userId),
    db.prepare("UPDATE disputes SET summary = '[deleted]' WHERE raised_by_user_id = ?1").bind(userId),
    db.prepare("DELETE FROM lft_reports WHERE reporter = ?1").bind(reporterKey),
    db.prepare("UPDATE disputes SET resolution_note = '[deleted]' WHERE resolved_by_user_id = ?1").bind(userId),
  ];
}

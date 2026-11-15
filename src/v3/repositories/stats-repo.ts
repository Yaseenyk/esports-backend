/**
 * Resume stats source rows. ONLY results the platform itself holds: finished or forfeited head-to-head matches and battle royale rows of PUBLIC, not hidden
 * tournaments, for teams the user captains (v3_team_captains, proven with the legacy captain link) and whose registration was approved. Nothing here reads a
 * number the player typed. Constant SQL, every value bound. Decides nothing about who may see the stats.
 */

export interface StatMatchRow { event_id: string; id: string; game: string; side: "a" | "b"; stage: string; score_a: number | null; score_b: number | null; winner: string | null }
export async function verifiedMatchRows(db: D1Database, userId: string): Promise<StatMatchRow[]> {
  const r = await db
    .prepare(
      "SELECT m.event_id AS event_id, m.id AS id, t.game AS game, CASE WHEN lower(m.a) = c.team_key THEN 'a' ELSE 'b' END AS side, m.stage AS stage, m.score_a AS score_a, m.score_b AS score_b, m.winner AS winner FROM v3_team_captains c JOIN tournaments t ON t.event_id = c.event_id JOIN matches m ON m.event_id = c.event_id AND (lower(m.a) = c.team_key OR lower(m.b) = c.team_key) WHERE c.user_id = ?1 AND t.status IN ('published','registration_open','registration_closed','live','completed') AND m.status IN ('finished','forfeit') AND EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = c.event_id AND lower(r.team_name) = c.team_key AND r.status = 'approved') AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = c.event_id) AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = c.event_id AND o.status = 'suspended') ORDER BY m.event_id, m.id LIMIT 2000",
    )
    .bind(userId)
    .all<StatMatchRow>();
  return r.results;
}

export interface StatBrRow { event_id: string; game: string; match_no: number; team: string; placement: number; kills: number }
export async function verifiedBrRows(db: D1Database, userId: string): Promise<StatBrRow[]> {
  const r = await db
    .prepare(
      "SELECT b.event_id AS event_id, t.game AS game, b.match_no AS match_no, b.team AS team, b.placement AS placement, b.kills AS kills FROM v3_team_captains c JOIN tournaments t ON t.event_id = c.event_id JOIN br_results b ON b.event_id = c.event_id AND lower(b.team) = c.team_key WHERE c.user_id = ?1 AND t.status IN ('published','registration_open','registration_closed','live','completed') AND EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = c.event_id AND lower(r.team_name) = c.team_key AND r.status = 'approved') AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = c.event_id) AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = c.event_id AND o.status = 'suspended') ORDER BY b.event_id, b.match_no LIMIT 2000",
    )
    .bind(userId)
    .all<StatBrRow>();
  return r.results;
}

export interface StatCorrectionRow { match_ref: string; old_value: string; new_value: string; created_at: number }
/** Result corrections (resolved disputes) for the events the user's teams played in. */
export async function correctionsForUser(db: D1Database, userId: string): Promise<StatCorrectionRow[]> {
  const r = await db
    .prepare("SELECT x.match_ref AS match_ref, x.old_value AS old_value, x.new_value AS new_value, x.created_at AS created_at FROM v3_result_corrections x WHERE x.event_id IN (SELECT c.event_id FROM v3_team_captains c WHERE c.user_id = ?1) ORDER BY x.created_at, x.id LIMIT 1000")
    .bind(userId)
    .all<StatCorrectionRow>();
  return r.results;
}

/** Battle royale rows written from a CONFIRMED screenshot review (flag v3.screenshots). The only v3 writer of br_results; legacy src/matches.ts is the other. */
export interface BrRowIn { team: string; placement: number; kills: number }

/** Team names confirmed in the event (approved registrations and roster teams), for matching what the screenshot reader found. */
export async function confirmedTeamNames(db: D1Database, eventId: string): Promise<string[]> {
  const r = await db
    .prepare("SELECT team_name AS name FROM registrations WHERE event_id = ?1 AND status = 'approved' UNION SELECT name FROM teams WHERE event_id = ?1 ORDER BY name LIMIT 300")
    .bind(eventId)
    .all<{ name: string }>();
  return r.results.map((x) => x.name);
}

/** The match numbers that already have battle royale rows. */
export async function brMatchNumbers(db: D1Database, eventId: string): Promise<number[]> {
  const r = await db.prepare("SELECT DISTINCT match_no FROM br_results WHERE event_id = ?1 ORDER BY match_no LIMIT 1000").bind(eventId).all<{ match_no: number }>();
  return r.results.map((x) => x.match_no);
}

export async function brRowCount(db: D1Database, eventId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM br_results WHERE event_id = ?1").bind(eventId).first<{ n: number }>())?.n ?? 0;
}

/** Writes one match in one batch. `replace` first removes that match's existing rows (and only that match's). */
export async function writeBrMatch(db: D1Database, eventId: string, matchNo: number, rows: readonly BrRowIn[], replace: boolean, atIso: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  if (replace) stmts.push(db.prepare("DELETE FROM br_results WHERE event_id = ?1 AND match_no = ?2").bind(eventId, matchNo));
  for (const r of rows) {
    stmts.push(
      db
        .prepare("INSERT INTO br_results (event_id, match_no, team, placement, kills, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (event_id, match_no, team) DO UPDATE SET placement = excluded.placement, kills = excluded.kills, updated_at = excluded.updated_at")
        .bind(eventId, matchNo, r.team, r.placement, r.kills, atIso),
    );
  }
  await db.batch(stmts);
}

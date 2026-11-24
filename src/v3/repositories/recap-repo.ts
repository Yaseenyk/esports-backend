/** Reads for the match recap (flag v3.recaps): the organiser's own scoring settings (legacy league_settings). Results come from tournament-repo. */
export interface ScoringRow { title: string; scale: string; per_kill: number; win_pts: number; draw_pts: number; loss_pts: number }

/** The event's points rules when the organiser saved them in the leaderboard tool, or null. Never invents a default. */
export async function leagueScoring(db: D1Database, eventId: string): Promise<ScoringRow | null> {
  return (
    (await db
      .prepare("SELECT title, scale, per_kill, win_pts, draw_pts, loss_pts FROM league_settings WHERE event_id = ?1")
      .bind(eventId)
      .first<ScoringRow>()) ?? null
  );
}

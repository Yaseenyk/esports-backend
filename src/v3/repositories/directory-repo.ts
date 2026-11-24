/**
 * Phase 5 (migration 0056): the public tournament directory. Reads upcoming public tournaments and the organiser's opt-in (v3_tournament_directory).
 * The only place v3_tournament_directory is queried. A repository decides nothing: the service applies the opt-in and the "registration open" rule.
 * The registration form's encrypted token is selected ONLY for a tournament whose organiser opted in AND whose registration is open.
 */

export interface DirectoryRow {
  id: string; event_id: string; slug: string; title: string; game: string; format: string; status: string; summary: string | null; venue: string; city: string | null; state: string | null;
  starts_at: number; ends_at: number | null; max_teams: number | null; registered: number;
  signup_public: number; f_token: string | null; f_token_enc: string | null; f_open: number | null; f_closes_at: string | null; f_max_teams: number | null;
}

/** Upcoming = public status before completion, a start date, and not over yet (end date, or start + 1 day, still ahead). Soonest first. */
export async function listUpcoming(db: D1Database, f: { now: number; game?: string; city?: string; limit: number }): Promise<DirectoryRow[]> {
  const r = await db
    .prepare(
      `SELECT t.id, t.event_id, t.slug, t.title, t.game, t.format, t.status, t.summary, t.venue, t.city, t.state, t.starts_at, t.ends_at, t.max_teams,
         (SELECT COUNT(*) FROM registrations r WHERE r.event_id = t.event_id AND r.status != 'rejected') AS registered,
         COALESCE(d.signup_public, 0) AS signup_public,
         CASE WHEN COALESCE(d.signup_public, 0) = 1 AND t.status = 'registration_open' THEN f.token END AS f_token,
         CASE WHEN COALESCE(d.signup_public, 0) = 1 AND t.status = 'registration_open' THEN f.token_enc END AS f_token_enc,
         f.open AS f_open, f.closes_at AS f_closes_at, f.max_teams AS f_max_teams
       FROM tournaments t LEFT JOIN v3_tournament_directory d ON d.tournament_id = t.id LEFT JOIN registration_forms f ON f.event_id = t.event_id
       WHERE t.status IN ('published','registration_open','registration_closed','live') AND t.starts_at IS NOT NULL AND COALESCE(t.ends_at, t.starts_at + 86400) >= ?1
         AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id)
         AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = t.event_id AND o.status = 'suspended')
         AND (?2 IS NULL OR t.game = ?2) AND (?3 IS NULL OR lower(t.city) = lower(?3))
       ORDER BY t.starts_at ASC, t.slug ASC LIMIT ?4`,
    )
    .bind(f.now, f.game ?? null, f.city ?? null, f.limit)
    .all<DirectoryRow>();
  return r.results;
}

export interface DirectoryFacets { total: number; cities: { city: string; count: number }[]; games: { game: string; count: number }[] }
/** Counts over ALL upcoming public tournaments (no filter): the total decides whether the directory may be indexed; the facets feed the filters. */
export async function upcomingFacets(db: D1Database, now: number): Promise<DirectoryFacets> {
  const [total, cities, games] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS n FROM tournaments t WHERE t.status IN ('published','registration_open','registration_closed','live') AND t.starts_at IS NOT NULL AND COALESCE(t.ends_at, t.starts_at + 86400) >= ?1
         AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id)
         AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = t.event_id AND o.status = 'suspended')`,
    ).bind(now),
    db.prepare(
      `SELECT MIN(t.city) AS city, COUNT(*) AS count FROM tournaments t WHERE t.city IS NOT NULL AND t.city != '' AND t.status IN ('published','registration_open','registration_closed','live') AND t.starts_at IS NOT NULL AND COALESCE(t.ends_at, t.starts_at + 86400) >= ?1
         AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id)
         AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = t.event_id AND o.status = 'suspended')
       GROUP BY lower(t.city) ORDER BY count DESC, city ASC LIMIT 50`,
    ).bind(now),
    db.prepare(
      `SELECT t.game AS game, COUNT(*) AS count FROM tournaments t WHERE t.status IN ('published','registration_open','registration_closed','live') AND t.starts_at IS NOT NULL AND COALESCE(t.ends_at, t.starts_at + 86400) >= ?1
         AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id)
         AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = t.event_id AND o.status = 'suspended')
       GROUP BY t.game ORDER BY count DESC, game ASC`,
    ).bind(now),
  ]);
  return {
    total: ((total?.results ?? []) as { n: number }[])[0]?.n ?? 0,
    cities: (cities?.results ?? []) as { city: string; count: number }[],
    games: (games?.results ?? []) as { game: string; count: number }[],
  };
}

export async function getSetting(db: D1Database, tournamentId: string): Promise<{ signup_public: number; updated_at: number } | null> {
  return (await db.prepare("SELECT signup_public, updated_at FROM v3_tournament_directory WHERE tournament_id = ?1").bind(tournamentId).first<{ signup_public: number; updated_at: number }>()) ?? null;
}
export async function setSetting(db: D1Database, tournamentId: string, signupPublic: boolean, at: number): Promise<void> {
  await db
    .prepare("INSERT INTO v3_tournament_directory (tournament_id, signup_public, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (tournament_id) DO UPDATE SET signup_public = ?2, updated_at = ?3")
    .bind(tournamentId, signupPublic ? 1 : 0, at)
    .run();
}
/** The event's registration form state (no token). */
export async function formState(db: D1Database, eventId: string): Promise<{ open: number; closes_at: string | null; max_teams: number | null } | null> {
  return (await db.prepare("SELECT open, closes_at, max_teams FROM registration_forms WHERE event_id = ?1").bind(eventId).first<{ open: number; closes_at: string | null; max_teams: number | null }>()) ?? null;
}

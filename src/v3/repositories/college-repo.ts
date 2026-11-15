/** Public college (verified organisation) reads: organisations (+ events.org_id) and the tournaments wrapper. Constant SQL, every value bound. Decides nothing about who may see a row. */
import { and, asc, desc, inArray, sql } from "drizzle-orm";
import { orm, schema } from "./db";
import { PUBLIC_STATUSES, type TournamentRow } from "./tournament-repo";

const { tournaments } = schema;

export interface CollegeRow { id: string; slug: string; name: string }

/** A verified, active organisation by public slug. The page still needs one real tournament (the service checks). */
export async function findVerifiedBySlug(db: D1Database, slug: string): Promise<CollegeRow | null> {
  const r = await db
    .prepare("SELECT id, slug, name FROM organisations WHERE slug = ?1 AND verified_at IS NOT NULL AND status = 'active' AND kind = 'team'")
    .bind(slug)
    .first<CollegeRow>();
  return r ?? null;
}

/** Public tournaments of the organisation, newest first. Events with a hidden takedown never appear (checked in SQL, whatever takedown.enforce says). */
export async function publicTournamentsOf(db: D1Database, orgId: string, limit: number): Promise<TournamentRow[]> {
  return orm(db)
    .select()
    .from(tournaments)
    .where(
      and(
        inArray(tournaments.status, [...PUBLIC_STATUSES]),
        sql`${tournaments.eventId} IN (SELECT e.id FROM events e WHERE e.org_id = ${orgId} AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = e.id))`,
      ),
    )
    .orderBy(desc(tournaments.startsAt), asc(tournaments.slug))
    .limit(limit);
}

export interface CollegeListRow { slug: string; name: string; tournaments: number; indexable: number; lastStartsAt: number | null }
/** Verified, active organisations with at least one public tournament. Counts only public, not-hidden tournaments. */
export async function listWithTournaments(db: D1Database, limit: number): Promise<CollegeListRow[]> {
  const r = await db
    .prepare(
      "SELECT o.slug AS slug, o.name AS name, COUNT(t.id) AS tournaments, COALESCE(SUM(t.seo_ready), 0) AS indexable, MAX(t.starts_at) AS last_starts_at FROM organisations o JOIN events e ON e.org_id = o.id JOIN tournaments t ON t.event_id = e.id WHERE o.slug IS NOT NULL AND o.verified_at IS NOT NULL AND o.status = 'active' AND o.kind = 'team' AND t.status IN ('published','registration_open','registration_closed','live','completed') AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = e.id) GROUP BY o.id ORDER BY o.slug LIMIT ?1",
    )
    .bind(limit)
    .all<{ slug: string; name: string; tournaments: number; indexable: number; last_starts_at: number | null }>();
  return r.results.map((x) => ({ slug: x.slug, name: x.name, tournaments: x.tournaments, indexable: x.indexable, lastStartsAt: x.last_starts_at }));
}

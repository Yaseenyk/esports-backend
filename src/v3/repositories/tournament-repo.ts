/** tournaments (v3 wrapper) and the READ-ONLY legacy reads behind it. The only place these tables are queried. */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { orm, schema } from "./db";
import { takenDown } from "../../moderation";

const { tournaments } = schema;
export type TournamentRow = typeof tournaments.$inferSelect;
export type TournamentInsert = typeof tournaments.$inferInsert;

export const PUBLIC_STATUSES = ["published", "registration_open", "registration_closed", "live", "completed"] as const;

export async function findByEventId(db: D1Database, eventId: string): Promise<TournamentRow | null> {
  return (await orm(db).select().from(tournaments).where(eq(tournaments.eventId, eventId)).get()) ?? null;
}
export async function findBySlug(db: D1Database, slug: string): Promise<TournamentRow | null> {
  return (await orm(db).select().from(tournaments).where(eq(tournaments.slug, slug)).get()) ?? null;
}
export async function findById(db: D1Database, id: string): Promise<TournamentRow | null> {
  return (await orm(db).select().from(tournaments).where(eq(tournaments.id, id)).get()) ?? null;
}
export async function slugTaken(db: D1Database, slug: string): Promise<boolean> {
  return (await orm(db).select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.slug, slug)).get()) !== undefined;
}

/** Inserts the wrapper. Returns false when the slug or the event already has one (unique indexes), so two racing creates cannot both win. */
export async function insert(db: D1Database, row: TournamentInsert): Promise<boolean> {
  try {
    await orm(db).insert(tournaments).values(row);
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) return false;
    throw e;
  }
}

export async function update(db: D1Database, id: string, patch: Partial<TournamentInsert>): Promise<void> {
  await orm(db).update(tournaments).set(patch).where(eq(tournaments.id, id));
}

/** Another PUBLISHED tournament already uses this title (case-insensitive). */
export async function titleUsedByOther(db: D1Database, title: string, exceptId: string): Promise<boolean> {
  const r = await orm(db)
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(and(sql`lower(${tournaments.title}) = lower(${title})`, ne(tournaments.id, exceptId), inArray(tournaments.status, [...PUBLIC_STATUSES])))
    .get();
  return r !== undefined;
}

export interface ListFilter { status?: string; game?: string; limit: number }
export async function listPublic(db: D1Database, f: ListFilter): Promise<TournamentRow[]> {
  const conds = [f.status ? eq(tournaments.status, f.status as (typeof PUBLIC_STATUSES)[number]) : inArray(tournaments.status, [...PUBLIC_STATUSES])];
  if (f.game) conds.push(eq(tournaments.game, f.game as TournamentRow["game"]));
  return orm(db).select().from(tournaments).where(and(...conds)).orderBy(desc(tournaments.startsAt), asc(tournaments.slug)).limit(f.limit);
}

// ---------------- legacy reads (events, registrations, matches, br_results, team_profiles). Explicit column lists: nothing private can come along. ----------------

export interface LegacyCounts { registered: number; approved: number }
export async function registrationCounts(db: D1Database, eventId: string): Promise<LegacyCounts> {
  const r = await db
    .prepare("SELECT COUNT(*) AS registered, COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved FROM registrations WHERE event_id = ?1 AND status != 'rejected'")
    .bind(eventId)
    .first<{ registered: number; approved: number }>();
  return { registered: r?.registered ?? 0, approved: r?.approved ?? 0 };
}

export interface PublicTeamRow { team_name: string; slug: string }
/** Approved teams that chose to be public: their registration is approved AND a published, not hidden team page covers that team name in this event. */
export async function publicTeams(db: D1Database, eventId: string): Promise<PublicTeamRow[]> {
  const r = await db
    .prepare(
      "SELECT DISTINCT r.team_name AS team_name, p.slug AS slug FROM registrations r JOIN team_profile_events pe ON pe.event_id = r.event_id AND lower(pe.team_name) = lower(r.team_name) JOIN team_profiles p ON p.id = pe.profile_id AND p.published = 1 WHERE r.event_id = ?1 AND r.status = 'approved' AND NOT EXISTS (SELECT 1 FROM takedowns t WHERE t.target_type = 'team_profile' AND t.target_id = p.id AND t.state = 'hidden') ORDER BY r.team_name LIMIT 200",
    )
    .bind(eventId)
    .all<PublicTeamRow>();
  return r.results;
}

export interface MatchRow { id: string; stage: string; round: number; slot: number; a: string; b: string; status: string; score_a: number | null; score_b: number | null; winner: string | null; starts_at: string | null }
export async function legacyMatches(db: D1Database, eventId: string): Promise<MatchRow[]> {
  const r = await db
    .prepare("SELECT id, stage, round, slot, a, b, status, score_a, score_b, winner, starts_at FROM matches WHERE event_id = ?1 ORDER BY stage, round, slot LIMIT 500")
    .bind(eventId)
    .all<MatchRow>();
  return r.results;
}
export interface BrRow { match_no: number; team: string; placement: number; kills: number }
export async function legacyBrResults(db: D1Database, eventId: string): Promise<BrRow[]> {
  const r = await db
    .prepare("SELECT match_no, team, placement, kills FROM br_results WHERE event_id = ?1 ORDER BY match_no, placement LIMIT 2000")
    .bind(eventId)
    .all<BrRow>();
  return r.results;
}

export interface CorrectionRow { id: string; match_ref: string; old_value: string; new_value: string; created_at: number }
export async function correctionsFor(db: D1Database, eventId: string): Promise<CorrectionRow[]> {
  const r = await db
    .prepare("SELECT id, match_ref, old_value, new_value, created_at FROM v3_result_corrections WHERE event_id = ?1 ORDER BY created_at, id LIMIT 500")
    .bind(eventId)
    .all<CorrectionRow>();
  return r.results;
}

/** True when moderation hides this event (takedown or suspended organisation). Honours flag takedown.enforce, like every public route. */
export async function eventHidden(db: D1Database, eventId: string): Promise<boolean> {
  return takenDown(db, { type: "event", id: eventId, eventId });
}

/** Number of disputes on this tournament that are still undecided (blocks `completed`). */
export async function undecidedDisputes(db: D1Database, tournamentId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM disputes WHERE tournament_id = ?1 AND status IN ('open','evidence_requested','under_review','escalated')")
    .bind(tournamentId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** True when the event has verified results: a finished or forfeited head-to-head match, or any battle royale row (organiser-entered). */
export async function hasVerifiedResults(db: D1Database, eventId: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM matches WHERE event_id = ?1 AND status IN ('finished','forfeit') UNION ALL SELECT 1 AS x FROM br_results WHERE event_id = ?1 LIMIT 1")
    .bind(eventId)
    .first();
  return r !== null;
}

/** lft_listings, lft_applications, lft_reports. The only place these tables are queried. A repository never decides who may see a row. */
import { eq } from "drizzle-orm";
import { orm, schema } from "./db";

const { lftListings, lftApplications } = schema;
export type ListingRow = typeof lftListings.$inferSelect;
export type ListingInsert = typeof lftListings.$inferInsert;
export type ApplicationRow = typeof lftApplications.$inferSelect;

export async function findListing(db: D1Database, id: string): Promise<ListingRow | null> {
  return (await orm(db).select().from(lftListings).where(eq(lftListings.id, id)).get()) ?? null;
}

/** The author's team page (legacy team_profiles) when they own it: the rule "a looking_for_player post names a team its author owns". */
export async function ownsTeamProfile(db: D1Database, userId: string, teamProfileId: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM team_profiles WHERE id = ?1 AND owner_user_id = ?2").bind(teamProfileId, userId).first();
  return r !== null;
}

/**
 * Inserts a listing only while the author has fewer than `cap` OPEN listings (one atomic statement, so two parallel posts cannot both pass).
 * Returns false when the cap is reached.
 */
export async function insertListingCapped(db: D1Database, l: ListingInsert, cap: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO lft_listings (id, kind, author_user_id, team_profile_id, game, roles, rank_min_ordinal, rank_max_ordinal, state, city, online_ok, message, contact, status, expires_at, last_bumped_at, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'open', ?14, ?15, ?15, ?15
       WHERE (SELECT COUNT(*) FROM lft_listings WHERE author_user_id = ?3 AND status = 'open') < ?16`,
    )
    .bind(l.id, l.kind, l.authorUserId, l.teamProfileId ?? null, l.game, l.roles ?? "[]", l.rankMinOrdinal ?? null, l.rankMaxOrdinal ?? null, l.state ?? null, l.city ?? null, l.onlineOk === false ? 0 : 1, l.message, l.contact ?? null, l.expiresAt, l.lastBumpedAt ?? 0, cap)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

export interface PublicFilter {
  now: number;
  game?: string;
  kind?: string;
  role?: string;
  rankMin?: number;
  rankMax?: number;
  state?: string;
  city?: string;
  onlineOk?: boolean;
  cursor?: { ts: number; id: string };
  limit: number;
}
export type PublicListingRow = ListingRowRaw & { team_name: string | null };
interface ListingRowRaw {
  id: string; kind: string; game: string; roles: string; rank_min_ordinal: number | null; rank_max_ordinal: number | null; state: string | null; city: string | null;
  online_ok: number; message: string; expires_at: number; last_bumped_at: number; created_at: number;
}

/**
 * ONLY open, not hidden, not expired listings. Selects explicit columns: author id, contact and report data are never read here.
 * The SQL is ONE constant string (test/hardening.test.ts forbids built SQL): every optional filter is `(?n IS NULL OR ...)` with a NULL bind when unused.
 */
export async function listPublic(db: D1Database, f: PublicFilter): Promise<PublicListingRow[]> {
  const r = await db
    .prepare(
      `SELECT l.id, l.kind, l.game, l.roles, l.rank_min_ordinal, l.rank_max_ordinal, l.state, l.city, l.online_ok, l.message, l.expires_at, l.last_bumped_at, l.created_at, tp.name AS team_name
       FROM lft_listings l LEFT JOIN team_profiles tp ON tp.id = l.team_profile_id
       WHERE l.status = 'open' AND l.hidden_at IS NULL AND l.expires_at > ?1
         AND (?2 IS NULL OR l.game = ?2)
         AND (?3 IS NULL OR l.kind = ?3)
         AND (?4 IS NULL OR EXISTS (SELECT 1 FROM json_each(l.roles) WHERE value = ?4))
         AND (?5 IS NULL OR l.rank_max_ordinal IS NULL OR l.rank_max_ordinal >= ?5)
         AND (?6 IS NULL OR l.rank_min_ordinal IS NULL OR l.rank_min_ordinal <= ?6)
         AND (?7 IS NULL OR lower(l.state) = lower(?7))
         AND (?8 IS NULL OR lower(l.city) = lower(?8))
         AND (?9 = 0 OR l.online_ok = 1)
         AND (?10 IS NULL OR l.last_bumped_at < ?10 OR (l.last_bumped_at = ?10 AND l.id < ?11))
       ORDER BY l.last_bumped_at DESC, l.id DESC LIMIT ?12`,
    )
    .bind(f.now, f.game ?? null, f.kind ?? null, f.role ?? null, f.rankMin ?? null, f.rankMax ?? null, f.state ?? null, f.city ?? null, f.onlineOk ? 1 : 0, f.cursor?.ts ?? null, f.cursor?.id ?? null, f.limit)
    .all<PublicListingRow>();
  return r.results;
}

export async function findPublicListing(db: D1Database, id: string, now: number): Promise<PublicListingRow | null> {
  const r = await db
    .prepare(
      `SELECT l.id, l.kind, l.game, l.roles, l.rank_min_ordinal, l.rank_max_ordinal, l.state, l.city, l.online_ok, l.message, l.expires_at, l.last_bumped_at, l.created_at, tp.name AS team_name
       FROM lft_listings l LEFT JOIN team_profiles tp ON tp.id = l.team_profile_id WHERE l.id = ?1 AND l.status = 'open' AND l.hidden_at IS NULL AND l.expires_at > ?2`,
    )
    .bind(id, now)
    .first<PublicListingRow>();
  return r ?? null;
}

export async function listMine(db: D1Database, userId: string): Promise<(ListingRow & { applications: number })[]> {
  const r = await db
    .prepare("SELECT l.*, (SELECT COUNT(*) FROM lft_applications a WHERE a.listing_id = l.id) AS applications FROM lft_listings l WHERE l.author_user_id = ?1 ORDER BY l.created_at DESC LIMIT 50")
    .bind(userId)
    .all<Record<string, unknown>>();
  // Map the snake_case row by hand: this query is the one place a raw row is returned.
  return r.results.map((x) => ({
    id: x.id as string, kind: x.kind as ListingRow["kind"], authorUserId: x.author_user_id as string, teamProfileId: (x.team_profile_id as string | null) ?? null, game: x.game as ListingRow["game"],
    roles: x.roles as string, rankMinOrdinal: (x.rank_min_ordinal as number | null) ?? null, rankMaxOrdinal: (x.rank_max_ordinal as number | null) ?? null, state: (x.state as string | null) ?? null,
    city: (x.city as string | null) ?? null, onlineOk: x.online_ok === 1, message: x.message as string, contact: (x.contact as string | null) ?? null, status: x.status as ListingRow["status"],
    hiddenAt: (x.hidden_at as number | null) ?? null, expiresAt: x.expires_at as number, lastBumpedAt: x.last_bumped_at as number, reportCount: x.report_count as number,
    createdAt: x.created_at as number, updatedAt: x.updated_at as number, applications: x.applications as number,
  }));
}

/** open -> filled | closed | removed. Returns whether a row changed. */
export async function closeListing(db: D1Database, id: string, to: "filled" | "closed" | "removed", at: number): Promise<boolean> {
  const r = await db.prepare("UPDATE lft_listings SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'open'").bind(id, to, at).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** Bump: only the author, only an open listing, only when the last bump is at least `gapSec` old. Atomic. */
export async function bumpListing(db: D1Database, id: string, userId: string, now: number, gapSec: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE lft_listings SET last_bumped_at = ?3, updated_at = ?3 WHERE id = ?1 AND author_user_id = ?2 AND status = 'open' AND hidden_at IS NULL AND expires_at > ?3 AND last_bumped_at <= ?4")
    .bind(id, userId, now, now - gapSec)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

// ---------------- applications ----------------
export async function insertApplication(db: D1Database, a: { id: string; listingId: string; applicantUserId: string; message: string; contact: string; createdAt: number }): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO lft_applications (id, listing_id, applicant_user_id, message, contact, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6)")
      .bind(a.id, a.listingId, a.applicantUserId, a.message, a.contact, a.createdAt)
      .run();
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) return false;
    throw e;
  }
}
export async function findApplication(db: D1Database, id: string): Promise<ApplicationRow | null> {
  return (await orm(db).select().from(lftApplications).where(eq(lftApplications.id, id)).get()) ?? null;
}
export interface ApplicationForAuthor { id: string; message: string | null; contact: string | null; status: string; created_at: number; responded_at: number | null; profile_slug: string | null }
/** Applications on one listing, for its author. The applicant's profile slug is returned only when that profile is public and consented. */
export async function listApplicationsForListing(db: D1Database, listingId: string): Promise<ApplicationForAuthor[]> {
  const r = await db
    .prepare(
      `SELECT a.id, a.message, a.contact, a.status, a.created_at, a.responded_at,
         (SELECT p.slug FROM player_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = a.applicant_user_id AND p.visibility = 'public' AND u.resume_consent_at IS NOT NULL AND u.adult_confirmed_at IS NOT NULL) AS profile_slug
       FROM lft_applications a WHERE a.listing_id = ?1 ORDER BY a.created_at DESC LIMIT 100`,
    )
    .bind(listingId)
    .all<ApplicationForAuthor>();
  return r.results;
}
export interface ApplicationForApplicant { id: string; listing_id: string; status: string; created_at: number; responded_at: number | null; kind: string; game: string; team_name: string | null; listing_contact: string | null; listing_status: string }
export async function listMyApplications(db: D1Database, userId: string): Promise<ApplicationForApplicant[]> {
  const r = await db
    .prepare(
      `SELECT a.id, a.listing_id, a.status, a.created_at, a.responded_at, l.kind, l.game, tp.name AS team_name, l.contact AS listing_contact, l.status AS listing_status
       FROM lft_applications a JOIN lft_listings l ON l.id = a.listing_id LEFT JOIN team_profiles tp ON tp.id = l.team_profile_id
       WHERE a.applicant_user_id = ?1 ORDER BY a.created_at DESC LIMIT 100`,
    )
    .bind(userId)
    .all<ApplicationForApplicant>();
  return r.results;
}
/** sent -> accepted | declined | withdrawn, atomically. */
export async function setApplicationStatus(db: D1Database, id: string, to: "accepted" | "declined" | "withdrawn", at: number): Promise<boolean> {
  const r = await db.prepare("UPDATE lft_applications SET status = ?2, responded_at = ?3 WHERE id = ?1 AND status = 'sent'").bind(id, to, at).run();
  return (r.meta?.changes ?? 0) === 1;
}

// ---------------- reports (auto-hide) ----------------
/**
 * Stores one report per (listing, reporter) and, in the same batch, hides the listing when `threshold` DISTINCT reporters exist.
 * Returns {stored, hidden}. `autoHide` false records the report only (rollout: flag takedown.enforce off).
 */
export async function fileListingReport(
  db: D1Database,
  r: { id: string; listingId: string; reporter: string; reasonCode: string; note: string; at: number },
  threshold: number,
  autoHide: boolean,
): Promise<{ stored: boolean; hidden: boolean }> {
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO lft_reports (id, listing_id, reporter, reason_code, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(r.id, r.listingId, r.reporter, r.reasonCode, r.note, r.at),
    db.prepare("UPDATE lft_listings SET report_count = (SELECT COUNT(DISTINCT reporter) FROM lft_reports WHERE listing_id = ?1) WHERE id = ?1").bind(r.listingId),
    db
      .prepare("UPDATE lft_listings SET hidden_at = ?2, updated_at = ?2 WHERE id = ?1 AND hidden_at IS NULL AND ?3 = 1 AND (SELECT COUNT(DISTINCT reporter) FROM lft_reports WHERE listing_id = ?1) >= ?4")
      .bind(r.listingId, r.at, autoHide ? 1 : 0, threshold),
  ]);
  return { stored: (res[0]?.meta.changes ?? 0) === 1, hidden: (res[2]?.meta.changes ?? 0) === 1 };
}

export interface HiddenRow { id: string; kind: string; game: string; message: string; status: string; hidden_at: number; report_count: number }
export async function listHidden(db: D1Database): Promise<HiddenRow[]> {
  const r = await db.prepare("SELECT id, kind, game, message, status, hidden_at, report_count FROM lft_listings WHERE hidden_at IS NOT NULL AND status = 'open' ORDER BY hidden_at DESC LIMIT 100").all<HiddenRow>();
  return r.results;
}
/** Moderator restore: clears the hide AND the old reports, so the same three reporters cannot re-hide it on the next report. */
export async function restoreListing(db: D1Database, id: string, at: number): Promise<boolean> {
  const res = await db.batch([
    db.prepare("UPDATE lft_listings SET hidden_at = NULL, report_count = 0, updated_at = ?2 WHERE id = ?1 AND hidden_at IS NOT NULL").bind(id, at),
    db.prepare("DELETE FROM lft_reports WHERE listing_id = ?1").bind(id),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}
export async function removeListing(db: D1Database, id: string, at: number): Promise<boolean> {
  const r = await db.prepare("UPDATE lft_listings SET status = 'removed', hidden_at = COALESCE(hidden_at, ?2), updated_at = ?2 WHERE id = ?1 AND status = 'open'").bind(id, at).run();
  return (r.meta?.changes ?? 0) === 1;
}

// ---------------- retention (scheduled) ----------------
export async function expireOpenListings(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare("UPDATE lft_listings SET status = 'expired', updated_at = ?1 WHERE status = 'open' AND expires_at <= ?1").bind(now).run();
  return r.meta?.changes ?? 0;
}
/** Deletes (cascading applications and reports) every listing whose expiry is more than `afterSec` in the past. At most 500 per run. */
export async function deleteOldListings(db: D1Database, now: number, afterSec: number): Promise<number> {
  const r = await db.prepare("DELETE FROM lft_listings WHERE id IN (SELECT id FROM lft_listings WHERE expires_at <= ?1 LIMIT 500)").bind(now - afterSec).run();
  return r.meta?.changes ?? 0;
}

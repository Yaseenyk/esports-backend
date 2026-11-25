/**
 * lft_listing_prefs, lft_application_contacts, lft_blocks, lft_application_reports (migration 0090): the LFT team-matching layer (flag v3.lft_match).
 * The only place these tables are queried. A repository decides nothing about who may see a row.
 */
import type { PublicListingRow } from "./lft-repo";

export interface MatchFilter {
  now: number; game?: string; kind?: string; role?: string; rankMin?: number; rankMax?: number; state?: string; city?: string; onlineOk?: boolean;
  language?: string; hours?: string; cursor?: { ts: number; id: string }; limit: number;
}
export type PublicMatchRow = PublicListingRow & { languages: string | null; play_hours: string | null };

/**
 * The public board with the matching facts. Same visibility rule and columns as lft-repo listPublic (open, not hidden, not expired; never the author,
 * the contact or report data), plus languages and play hours, and two more optional filters. ONE constant SQL string; unused filters bind NULL.
 */
export async function listPublicWithPrefs(db: D1Database, f: MatchFilter): Promise<PublicMatchRow[]> {
  const r = await db
    .prepare(
      `SELECT l.id, l.kind, l.game, l.roles, l.rank_min_ordinal, l.rank_max_ordinal, l.state, l.city, l.online_ok, l.message, l.expires_at, l.last_bumped_at, l.created_at, tp.name AS team_name,
         p.languages AS languages, p.play_hours AS play_hours
       FROM lft_listings l LEFT JOIN team_profiles tp ON tp.id = l.team_profile_id LEFT JOIN lft_listing_prefs p ON p.listing_id = l.id
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
         AND (?13 IS NULL OR EXISTS (SELECT 1 FROM json_each(COALESCE(p.languages, '[]')) WHERE value = ?13))
         AND (?14 IS NULL OR EXISTS (SELECT 1 FROM json_each(COALESCE(p.play_hours, '[]')) WHERE value = ?14))
       ORDER BY l.last_bumped_at DESC, l.id DESC LIMIT ?12`,
    )
    .bind(f.now, f.game ?? null, f.kind ?? null, f.role ?? null, f.rankMin ?? null, f.rankMax ?? null, f.state ?? null, f.city ?? null, f.onlineOk ? 1 : 0, f.cursor?.ts ?? null, f.cursor?.id ?? null, f.limit, f.language ?? null, f.hours ?? null)
    .all<PublicMatchRow>();
  return r.results;
}

export async function findPrefs(db: D1Database, listingId: string): Promise<{ languages: string; play_hours: string; contacts: string } | null> {
  return (await db.prepare("SELECT languages, play_hours, contacts FROM lft_listing_prefs WHERE listing_id = ?1").bind(listingId).first<{ languages: string; play_hours: string; contacts: string }>()) ?? null;
}

export async function upsertPrefs(db: D1Database, listingId: string, languages: string, playHours: string, contacts: string): Promise<void> {
  await db
    .prepare("INSERT INTO lft_listing_prefs (listing_id, languages, play_hours, contacts) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (listing_id) DO UPDATE SET languages = ?2, play_hours = ?3, contacts = ?4")
    .bind(listingId, languages, playHours, contacts)
    .run();
}

/** The chosen contacts of several listings at once (for the applicant's "sent" list). */
export async function listingContacts(db: D1Database, listingIds: string[]): Promise<Map<string, string>> {
  if (!listingIds.length) return new Map();
  const r = await db.prepare("SELECT listing_id, contacts FROM lft_listing_prefs WHERE listing_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(listingIds)).all<{ listing_id: string; contacts: string }>();
  return new Map(r.results.map((x) => [x.listing_id, x.contacts]));
}

export async function insertApplicationContacts(db: D1Database, applicationId: string, contacts: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO lft_application_contacts (application_id, contacts) VALUES (?1, ?2)").bind(applicationId, contacts).run();
}
export async function applicationContacts(db: D1Database, applicationIds: string[]): Promise<Map<string, string>> {
  if (!applicationIds.length) return new Map();
  const r = await db.prepare("SELECT application_id, contacts FROM lft_application_contacts WHERE application_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(applicationIds)).all<{ application_id: string; contacts: string }>();
  return new Map(r.results.map((x) => [x.application_id, x.contacts]));
}

// ---------------- blocks ----------------
export async function insertBlock(db: D1Database, b: { id: string; blocker: string; blocked: string; label: string; at: number }): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO lft_blocks (id, blocker_user_id, blocked_user_id, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(b.id, b.blocker, b.blocked, b.label, b.at).run();
}
export async function blockedEitherWay(db: D1Database, a: string, b: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM lft_blocks WHERE (blocker_user_id = ?1 AND blocked_user_id = ?2) OR (blocker_user_id = ?2 AND blocked_user_id = ?1)").bind(a, b).first()) !== null;
}
export async function listBlocks(db: D1Database, blocker: string): Promise<{ id: string; label: string; created_at: number }[]> {
  return (await db.prepare("SELECT id, label, created_at FROM lft_blocks WHERE blocker_user_id = ?1 ORDER BY created_at DESC LIMIT 200").bind(blocker).all<{ id: string; label: string; created_at: number }>()).results;
}
export async function deleteBlock(db: D1Database, id: string, blocker: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM lft_blocks WHERE id = ?1 AND blocker_user_id = ?2").bind(id, blocker).run();
  return (r.meta?.changes ?? 0) === 1;
}
/** After a poster blocks an applicant: that applicant's unanswered requests on ANY of the poster's listings are declined. */
export async function declinePendingFrom(db: D1Database, authorId: string, applicantId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE lft_applications SET status = 'declined', responded_at = ?3 WHERE applicant_user_id = ?2 AND status = 'sent' AND listing_id IN (SELECT id FROM lft_listings WHERE author_user_id = ?1)")
    .bind(authorId, applicantId, now)
    .run();
}
/** After an applicant blocks a poster: the applicant's own unanswered requests to that poster are withdrawn. */
export async function withdrawPendingTo(db: D1Database, applicantId: string, authorId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE lft_applications SET status = 'withdrawn', responded_at = ?3 WHERE applicant_user_id = ?1 AND status = 'sent' AND listing_id IN (SELECT id FROM lft_listings WHERE author_user_id = ?2)")
    .bind(applicantId, authorId, now)
    .run();
}

// ---------------- request reports ----------------
export async function fileApplicationReport(db: D1Database, r: { id: string; applicationId: string; reporter: string; reasonCode: string; note: string; at: number }): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO lft_application_reports (id, application_id, reporter, reason_code, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(r.id, r.applicationId, r.reporter, r.reasonCode, r.note, r.at)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}
export interface RequestReportRow { id: string; reason_code: string; note: string; created_at: number; message: string | null; game: string; reports_on_applicant: number }
/** Staff: the newest request reports, with the reported message and how many reports the same applicant has in total. No user ids leave this query. */
export async function listApplicationReports(db: D1Database, limit: number): Promise<RequestReportRow[]> {
  const r = await db
    .prepare(
      `SELECT rp.id, rp.reason_code, rp.note, rp.created_at, a.message, l.game,
         (SELECT COUNT(*) FROM lft_application_reports r2 JOIN lft_applications a2 ON a2.id = r2.application_id WHERE a2.applicant_user_id = a.applicant_user_id) AS reports_on_applicant
       FROM lft_application_reports rp JOIN lft_applications a ON a.id = rp.application_id JOIN lft_listings l ON l.id = a.listing_id
       ORDER BY rp.created_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<RequestReportRow>();
  return r.results;
}

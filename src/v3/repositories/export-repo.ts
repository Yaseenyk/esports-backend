/** Read-only queries behind "Download my data" for the v3 tables. Every row returned belongs to the given user. Constant SQL only; bounded by LIMIT. */
import { V3_TABLE_NAMES } from "../lib/personal-tables";

export async function existingTables(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(V3_TABLE_NAMES)).all<{ name: string }>();
  return new Set(r.results.map((x) => x.name));
}

export interface AccountV3Row { adult_confirmed_at: number | null; resume_consent_at: number | null; has_discord: number }
/** The three v3 columns on users (migration 0052). Columns that are not there yet read as empty. */
export async function accountRow(db: D1Database, userId: string): Promise<AccountV3Row | null> {
  const cols = new Set((await db.prepare("SELECT name FROM pragma_table_info('users') WHERE name IN ('adult_confirmed_at', 'resume_consent_at', 'discord_user_id')").all<{ name: string }>()).results.map((c) => c.name));
  // Migration 0052 adds all three columns together: either they are all there or none is. One constant query (the repo bans building SQL from strings).
  if (cols.size < 3) return null;
  return (await db.prepare("SELECT adult_confirmed_at, resume_consent_at, CASE WHEN discord_user_id IS NULL THEN 0 ELSE 1 END AS has_discord FROM users WHERE id = ?1").bind(userId).first<AccountV3Row>()) ?? null;
}

export interface ProfileRow { slug: string; handle: string; bio: string | null; city: string | null; state: string | null; languages: string; visibility: string; created_at: number }
export async function profileRow(db: D1Database, userId: string): Promise<ProfileRow | null> {
  return (await db.prepare("SELECT slug, handle, bio, city, state, languages, visibility, created_at FROM player_profiles WHERE user_id = ?1").bind(userId).first<ProfileRow>()) ?? null;
}
export interface GameRow { game: string; in_game_name: string; rank_code: string | null; rank_ordinal: number | null; roles: string }
export async function gameRows(db: D1Database, userId: string): Promise<GameRow[]> {
  return (await db.prepare("SELECT game, in_game_name, rank_code, rank_ordinal, roles FROM player_games WHERE user_id = ?1 ORDER BY game LIMIT 50").bind(userId).all<GameRow>()).results;
}

export interface ListingRow { id: string; kind: string; game: string; roles: string; message: string; status: string; created_at: number; expires_at: number; state: string | null; city: string | null; online_ok: number; received: number }
export async function listingRows(db: D1Database, userId: string, withCounts: boolean): Promise<ListingRow[]> {
  // Two constant queries (the repo bans building SQL from strings): with and without the per-listing count of applications received.
  const stmt = withCounts
    ? db.prepare("SELECT l.id AS id, l.kind AS kind, l.game AS game, l.roles AS roles, l.message AS message, l.status AS status, l.created_at AS created_at, l.expires_at AS expires_at, l.state AS state, l.city AS city, l.online_ok AS online_ok, (SELECT COUNT(*) FROM lft_applications a WHERE a.listing_id = l.id) AS received FROM lft_listings l WHERE l.author_user_id = ?1 ORDER BY l.created_at DESC, l.id LIMIT 200")
    : db.prepare("SELECT l.id AS id, l.kind AS kind, l.game AS game, l.roles AS roles, l.message AS message, l.status AS status, l.created_at AS created_at, l.expires_at AS expires_at, l.state AS state, l.city AS city, l.online_ok AS online_ok, 0 AS received FROM lft_listings l WHERE l.author_user_id = ?1 ORDER BY l.created_at DESC, l.id LIMIT 200");
  return (await stmt.bind(userId).all<ListingRow>()).results;
}
export interface SentApplicationRow { listing_id: string; message: string | null; status: string; created_at: number; responded_at: number | null }
export async function sentApplicationRows(db: D1Database, userId: string): Promise<SentApplicationRow[]> {
  return (await db.prepare("SELECT listing_id, message, status, created_at, responded_at FROM lft_applications WHERE applicant_user_id = ?1 ORDER BY created_at DESC, id LIMIT 500").bind(userId).all<SentApplicationRow>()).results;
}

export interface DisputeRow { id: string; tournament_slug: string | null; type: string; status: string; summary: string; created_at: number; resolved_at: number | null; outcome: string | null; resolution_note: string | null }
export async function disputeRows(db: D1Database, userId: string): Promise<DisputeRow[]> {
  return (await db.prepare("SELECT d.id AS id, t.slug AS tournament_slug, d.type AS type, d.status AS status, d.summary AS summary, d.created_at AS created_at, d.resolved_at AS resolved_at, d.outcome AS outcome, d.resolution_note AS resolution_note FROM disputes d LEFT JOIN tournaments t ON t.id = d.tournament_id WHERE d.raised_by_user_id = ?1 ORDER BY d.created_at DESC, d.id LIMIT 200").bind(userId).all<DisputeRow>()).results;
}
/** Metadata of the screenshots THIS user uploaded (never the bytes, never the caption). */
export interface EvidenceMetaRow { dispute_id: string; mime_type: string; size_bytes: number; created_at: number; purged: number }
export async function evidenceMetaRows(db: D1Database, userId: string): Promise<EvidenceMetaRow[]> {
  return (await db.prepare("SELECT dispute_id, mime_type, size_bytes, created_at, (purged_at IS NOT NULL) AS purged FROM dispute_evidence WHERE uploaded_by_user_id = ?1 ORDER BY created_at, id LIMIT 1000").bind(userId).all<EvidenceMetaRow>()).results;
}
export interface CaptainRow { event_id: string; team_name: string; created_at: number }
export async function captainRows(db: D1Database, userId: string): Promise<CaptainRow[]> {
  return (await db.prepare("SELECT event_id, team_name, created_at FROM v3_team_captains WHERE user_id = ?1 ORDER BY created_at, event_id LIMIT 200").bind(userId).all<CaptainRow>()).results;
}

// ---------------- phases 3-5 (migration 0056)
export interface TeamPageSettingRow { slug: string; name: string; visibility: string; public_since: number | null }
export async function teamPageSettingRows(db: D1Database, userId: string): Promise<TeamPageSettingRow[]> {
  return (await db.prepare("SELECT p.slug AS slug, p.name AS name, v.visibility AS visibility, v.public_since AS public_since FROM v3_team_pages v JOIN team_profiles p ON p.id = v.profile_id WHERE p.owner_user_id = ?1 ORDER BY p.slug LIMIT 50").bind(userId).all<TeamPageSettingRow>()).results;
}
export async function playerHiddenRows(db: D1Database, userId: string): Promise<{ item_key: string; created_at: number }[]> {
  return (await db.prepare("SELECT item_key, created_at FROM v3_player_hidden_items WHERE user_id = ?1 ORDER BY created_at LIMIT 200").bind(userId).all<{ item_key: string; created_at: number }>()).results;
}
export async function teamHiddenRows(db: D1Database, userId: string): Promise<{ slug: string; item_key: string; created_at: number }[]> {
  return (await db.prepare("SELECT p.slug AS slug, h.item_key AS item_key, h.created_at AS created_at FROM v3_team_hidden_items h JOIN team_profiles p ON p.id = h.profile_id WHERE p.owner_user_id = ?1 ORDER BY h.created_at LIMIT 500").bind(userId).all<{ slug: string; item_key: string; created_at: number }>()).results;
}

// ---------------- organiser trust ratings (migration 0080; not in lib/personal-tables.ts because the community tables are checked on their own)
export async function ratingTableExists(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'organiser_ratings'").first()) !== null;
}
/** Ratings THIS user wrote, with the organiser's reply to each (it is part of the same thread). Never the proof reference or who replied. */
export interface RatingWrittenRow { id: string; event_id: string; event_name: string | null; display_name: string; stars: number; on_time: number; fair_play: number; communication: number; review: string | null; reply: string | null; reply_at: number | null; hidden_at: number | null; reply_hidden_at: number | null; created_at: number; updated_at: number }
export async function ratingsWrittenRows(db: D1Database, userId: string): Promise<RatingWrittenRow[]> {
  return (await db.prepare("SELECT r.id AS id, r.event_id AS event_id, e.name AS event_name, r.display_name AS display_name, r.stars AS stars, r.on_time AS on_time, r.fair_play AS fair_play, r.communication AS communication, r.review AS review, CASE WHEN r.reply_hidden_at IS NULL THEN r.reply ELSE NULL END AS reply, r.reply_at AS reply_at, r.hidden_at AS hidden_at, r.reply_hidden_at AS reply_hidden_at, r.created_at AS created_at, r.updated_at AS updated_at FROM organiser_ratings r LEFT JOIN events e ON e.id = r.event_id WHERE r.user_id = ?1 ORDER BY r.created_at DESC, r.id LIMIT 500").bind(userId).all<RatingWrittenRow>()).results;
}
/**
 * Ratings OF the organisations this user is an admin of (the organisation's own reviews), with the organisation's replies. Only what the public page
 * shows about the rater: the display name they chose for the review. Never their account id or email. Reviews staff hid are left out (they were hidden
 * for abuse or personal details), and so is a hidden reply's text.
 */
export interface RatingReceivedRow { id: string; org_id: string; org_name: string; event_id: string; event_name: string | null; display_name: string; stars: number; on_time: number; fair_play: number; communication: number; review: string | null; reply: string | null; reply_at: number | null; reply_hidden: number; created_at: number }
export async function ratingsReceivedRows(db: D1Database, userId: string): Promise<RatingReceivedRow[]> {
  return (await db.prepare("SELECT r.id AS id, o.id AS org_id, o.name AS org_name, r.event_id AS event_id, e.name AS event_name, r.display_name AS display_name, r.stars AS stars, r.on_time AS on_time, r.fair_play AS fair_play, r.communication AS communication, r.review AS review, CASE WHEN r.reply_hidden_at IS NULL THEN r.reply ELSE NULL END AS reply, r.reply_at AS reply_at, CASE WHEN r.reply_hidden_at IS NULL THEN 0 ELSE 1 END AS reply_hidden, r.created_at AS created_at FROM org_members m JOIN organisations o ON o.id = m.org_id JOIN organiser_ratings r ON r.organiser_key = 'org:' || o.id LEFT JOIN events e ON e.id = r.event_id WHERE m.user_id = ?1 AND m.role = 'admin' AND r.hidden_at IS NULL ORDER BY r.created_at DESC, r.id LIMIT 2000").bind(userId).all<RatingReceivedRow>()).results;
}

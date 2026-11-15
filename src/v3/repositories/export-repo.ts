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

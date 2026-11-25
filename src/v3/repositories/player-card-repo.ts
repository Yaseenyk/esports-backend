/**
 * v3_player_page_details (migration 0081): a player's extra page details, field switches and the revocable card link. The only place this table is queried.
 * Constant SQL, every value bound. A repository never decides who may see a row: the service checks visibility, consent, 18+ and moderation.
 * Before 0081 is applied the reads answer "nothing stored" instead of failing, so a Worker deployed ahead of the migration keeps serving profiles.
 */
import type { ProfileRow } from "./profile-repo";

export interface DetailsRow {
  team_name: string | null;
  links: string;
  achievements: string;
  hidden_fields: string;
  card_token_enc: string | null;
  card_token_at: number | null;
  search_opt_in_at: number | null;
  updated_at: number;
}

const missingTable = (e: unknown): boolean => /no such table/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""));

export async function getDetails(db: D1Database, userId: string): Promise<DetailsRow | null> {
  try {
    return (
      (await db
        .prepare("SELECT team_name, links, achievements, hidden_fields, card_token_enc, card_token_at, search_opt_in_at, updated_at FROM v3_player_page_details WHERE user_id = ?1")
        .bind(userId)
        .first<DetailsRow>()) ?? null
    );
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

export async function upsertDetails(db: D1Database, userId: string, d: { teamName: string | null; links: string; achievements: string; hiddenFields: string; searchOptInAt: number | null }, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO v3_player_page_details (user_id, team_name, links, achievements, hidden_fields, search_opt_in_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (user_id) DO UPDATE SET team_name = ?2, links = ?3, achievements = ?4, hidden_fields = ?5, search_opt_in_at = ?6, updated_at = ?7`,
    )
    .bind(userId, d.teamName, d.links, d.achievements, d.hiddenFields, d.searchOptInAt, at)
    .run();
}

/** Stores a new card link (replacing any old one: the old token stops resolving in the same statement). */
export async function setCardToken(db: D1Database, userId: string, hash: string, enc: string, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO v3_player_page_details (user_id, card_token_hash, card_token_enc, card_token_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (user_id) DO UPDATE SET card_token_hash = ?2, card_token_enc = ?3, card_token_at = ?4, updated_at = ?4`,
    )
    .bind(userId, hash, enc, at)
    .run();
}

export async function deleteDetails(db: D1Database, userId: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM v3_player_page_details WHERE user_id = ?1").bind(userId).run();
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
}

/** Everything the service needs to decide on a card link, in ONE query whatever the outcome (so a revoked, private or unknown token costs the same). */
export interface CardTarget { profile: ProfileRow; adultConfirmedAt: number | null; resumeConsentAt: number | null; userStatus: string; hiddenAt: number | null }
export async function resolveCardToken(db: D1Database, hash: string): Promise<CardTarget | null> {
  let r: (ProfileRow & { adult: number | null; consent: number | null; userStatus: string; hiddenAt: number | null }) | null;
  try {
    r = await db
      .prepare(
        `SELECT p.user_id AS userId, p.slug AS slug, p.handle AS handle, p.bio AS bio, p.city AS city, p.state AS state, p.languages AS languages, p.visibility AS visibility,
                p.created_at AS createdAt, p.updated_at AS updatedAt, u.adult_confirmed_at AS adult, u.resume_consent_at AS consent, u.status AS userStatus, m.hidden_at AS hiddenAt
         FROM v3_player_page_details d
         JOIN player_profiles p ON p.user_id = d.user_id
         JOIN users u ON u.id = d.user_id
         LEFT JOIN v3_profile_moderation m ON m.target_kind = 'player' AND m.target_key = d.user_id
         WHERE d.card_token_hash = ?1`,
      )
      .bind(hash)
      .first();
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
  if (!r) return null;
  const { adult, consent, userStatus, hiddenAt, ...profile } = r;
  return { profile: profile as ProfileRow, adultConfirmedAt: adult, resumeConsentAt: consent, userStatus, hiddenAt };
}

/**
 * Candidates for an indexable /players/<slug>/ page: opted in to search, Public, 18+ confirmed, consent given, account active, not hidden by moderation.
 * The service still applies the content gate to each one. Oldest opt-in first, at most `limit`.
 */
export async function searchCandidates(db: D1Database, limit: number): Promise<{ profile: ProfileRow; searchSince: number }[]> {
  let rows: (ProfileRow & { searchSince: number })[];
  try {
    rows = (
      await db
        .prepare(
          `SELECT p.user_id AS userId, p.slug AS slug, p.handle AS handle, p.bio AS bio, p.city AS city, p.state AS state, p.languages AS languages, p.visibility AS visibility,
                  p.created_at AS createdAt, p.updated_at AS updatedAt, d.search_opt_in_at AS searchSince
           FROM v3_player_page_details d
           JOIN player_profiles p ON p.user_id = d.user_id
           JOIN users u ON u.id = d.user_id
           WHERE d.search_opt_in_at IS NOT NULL AND p.visibility = 'public' AND u.adult_confirmed_at IS NOT NULL AND u.resume_consent_at IS NOT NULL AND u.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM v3_profile_moderation m WHERE m.target_kind = 'player' AND m.target_key = d.user_id AND m.hidden_at IS NOT NULL)
           ORDER BY d.search_opt_in_at, p.slug LIMIT ?1`,
        )
        .bind(limit)
        .all<ProfileRow & { searchSince: number }>()
    ).results;
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
  return rows.map(({ searchSince, ...profile }) => ({ profile: profile as ProfileRow, searchSince }));
}

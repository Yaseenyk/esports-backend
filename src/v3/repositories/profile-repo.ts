/** player_profiles and player_games. The only place these tables are queried. */
import { and, eq, ne } from "drizzle-orm";
import { orm, schema } from "./db";

const { playerProfiles, playerGames } = schema;
export type ProfileRow = typeof playerProfiles.$inferSelect;
export type ProfileInsert = typeof playerProfiles.$inferInsert;
export type GameRow = typeof playerGames.$inferSelect;
export type GameInsert = typeof playerGames.$inferInsert;

export async function getProfile(db: D1Database, userId: string): Promise<ProfileRow | null> {
  return (await orm(db).select().from(playerProfiles).where(eq(playerProfiles.userId, userId)).get()) ?? null;
}
export async function slugTakenByOther(db: D1Database, slug: string, userId: string): Promise<boolean> {
  return (await orm(db).select({ u: playerProfiles.userId }).from(playerProfiles).where(and(eq(playerProfiles.slug, slug), ne(playerProfiles.userId, userId))).get()) !== undefined;
}
export async function insertProfile(db: D1Database, row: ProfileInsert): Promise<boolean> {
  try {
    await orm(db).insert(playerProfiles).values(row);
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) return false;
    throw e;
  }
}
export async function updateProfile(db: D1Database, userId: string, patch: Partial<ProfileInsert>): Promise<boolean> {
  try {
    await orm(db).update(playerProfiles).set(patch).where(eq(playerProfiles.userId, userId));
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) return false;
    throw e;
  }
}
/** Removes the profile and every game row of the user in one batch. */
export async function deleteProfile(db: D1Database, userId: string): Promise<void> {
  await db.batch([db.prepare("DELETE FROM player_games WHERE user_id = ?1").bind(userId), db.prepare("DELETE FROM player_profiles WHERE user_id = ?1").bind(userId)]);
}

export async function listGames(db: D1Database, userId: string): Promise<GameRow[]> {
  return orm(db).select().from(playerGames).where(eq(playerGames.userId, userId)).orderBy(playerGames.game);
}
export async function upsertGame(db: D1Database, row: GameInsert): Promise<void> {
  await orm(db)
    .insert(playerGames)
    .values(row)
    .onConflictDoUpdate({ target: [playerGames.userId, playerGames.game], set: { inGameName: row.inGameName, rankCode: row.rankCode, rankOrdinal: row.rankOrdinal, roles: row.roles, updatedAt: row.updatedAt } });
}
export async function deleteGame(db: D1Database, userId: string, game: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM player_games WHERE user_id = ?1 AND game = ?2").bind(userId, game).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** A profile with its owner's consent facts, by public slug. The SERVICE decides whether it may be shown. */
export interface ProfileWithConsent { profile: ProfileRow; adultConfirmedAt: number | null; resumeConsentAt: number | null; userStatus: string }
export async function getProfileBySlugWithConsent(db: D1Database, slug: string): Promise<ProfileWithConsent | null> {
  const p = (await orm(db).select().from(playerProfiles).where(eq(playerProfiles.slug, slug)).get()) ?? null;
  if (!p) return null;
  const u = await db.prepare("SELECT adult_confirmed_at, resume_consent_at, status FROM users WHERE id = ?1").bind(p.userId).first<{ adult_confirmed_at: number | null; resume_consent_at: number | null; status: string }>();
  if (!u) return null;
  return { profile: p, adultConfirmedAt: u.adult_confirmed_at, resumeConsentAt: u.resume_consent_at, userStatus: u.status };
}

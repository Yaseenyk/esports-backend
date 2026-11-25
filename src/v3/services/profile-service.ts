/** Esports Resume rules: profile, games, 18+ confirmation, resume consent, visibility. No SQL here. */
import { HttpError } from "../../http";
import { GAMES, PLAYER_ROLES, VISIBILITIES } from "../lib/enums";
import { nowSec, toIso } from "../lib/ids";
import { checkSlug } from "../lib/slug";
import { bad, enumArray, optEnum, optInt, optText, reqEnum, reqText, shortList } from "../lib/validate";
import * as profiles from "../repositories/profile-repo";
import * as stats from "../repositories/stats-repo";
import * as users from "../repositories/user-repo";
import { toOwnProfile, toPublicPlayer } from "../adapters/profile-adapter";
import { buildResumeStats } from "../adapters/stats-adapter";
import { deletePageDetails } from "./showcase-service";

/** Resume numbers: computed on every read from verified results (never stored, never typed by the player). */
async function statsOf(db: D1Database, userId: string) {
  const [m, b, c] = await Promise.all([stats.verifiedMatchRows(db, userId), stats.verifiedBrRows(db, userId), stats.correctionsForUser(db, userId)]);
  return buildResumeStats(m, b, c);
}

type Body = Record<string, unknown>;

async function me(db: D1Database, userId: string) {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  return u;
}

/** GET /v3/me/status: the two facts every v3 feature asks about. */
export async function myStatus(db: D1Database, userId: string) {
  const u = await me(db, userId);
  return { adultConfirmedAt: toIso(u.adultConfirmedAt), resumeConsentAt: toIso(u.resumeConsentAt) };
}

/** The 18+ confirmation. Stores the timestamp once; repeating it changes nothing. Existing accounts are not blocked until they use a v3 feature. */
export async function confirmAdult(db: D1Database, userId: string, b: Body) {
  if (b.adult !== true) throw bad("Confirm that you are 18 or older (adult: true)", "adult_required");
  const u = await me(db, userId);
  if (u.adultConfirmedAt === null) await users.setAdultConfirmed(db, userId, nowSec());
  return myStatus(db, userId);
}

export async function giveResumeConsent(db: D1Database, userId: string, b: Body) {
  if (b.consent !== true) throw bad("consent must be true", "consent_required");
  const u = await me(db, userId);
  if (u.adultConfirmedAt === null) throw new HttpError(409, "Confirm that you are 18 or older first", { code: "adult_required" });
  if (u.resumeConsentAt === null) await users.setResumeConsent(db, userId, nowSec());
  return myStatus(db, userId);
}

/** Withdrawing consent makes the profile private in the same batch: nothing stays public. */
export async function withdrawResumeConsent(db: D1Database, userId: string) {
  await me(db, userId);
  await users.withdrawResumeConsent(db, userId, nowSec());
  return myStatus(db, userId);
}

export async function getMyProfile(db: D1Database, userId: string) {
  const u = await me(db, userId);
  const p = await profiles.getProfile(db, userId);
  if (!p) return { profile: null, adultConfirmedAt: toIso(u.adultConfirmedAt), resumeConsentAt: toIso(u.resumeConsentAt) };
  return { profile: toOwnProfile(p, await profiles.listGames(db, userId), u, await statsOf(db, userId)) };
}

export async function putMyProfile(db: D1Database, userId: string, b: Body) {
  const u = await me(db, userId);
  const existing = await profiles.getProfile(db, userId);

  const patch: Partial<profiles.ProfileInsert> = {};
  if (b.slug !== undefined) {
    const c = checkSlug(b.slug);
    if (!c.ok) throw bad(`slug is not allowed (${c.reason})`, `slug_${c.reason}`);
    if (await profiles.slugTakenByOther(db, c.slug, userId)) throw new HttpError(409, "That slug is taken", { code: "slug_taken" });
    patch.slug = c.slug;
  }
  const handle = optText(b.handle, "handle", 40, 2);
  if (handle !== undefined) patch.handle = handle ?? "";
  const bio = optText(b.bio, "bio", 400);
  if (bio !== undefined) patch.bio = bio;
  const city = optText(b.city, "city", 60);
  if (city !== undefined) patch.city = city;
  const state = optText(b.state, "state", 60);
  if (state !== undefined) patch.state = state;
  if (b.languages !== undefined) patch.languages = JSON.stringify(shortList(b.languages, "languages", 6, 20));
  const visibility = optEnum(b.visibility, VISIBILITIES, "visibility");
  if (visibility) {
    if (visibility === "public") {
      if (u.adultConfirmedAt === null) throw new HttpError(409, "Confirm that you are 18 or older before making a profile public", { code: "adult_required" });
      if (u.resumeConsentAt === null) throw new HttpError(409, "Give consent to a public Esports Resume before making a profile public", { code: "consent_required" });
    }
    patch.visibility = visibility;
  }

  const at = nowSec();
  if (!existing) {
    if (!patch.slug || !patch.handle) throw bad("slug and handle are required to create a profile", "slug_and_handle_required");
    const ok = await profiles.insertProfile(db, { userId, slug: patch.slug, handle: patch.handle, bio: patch.bio ?? null, city: patch.city ?? null, state: patch.state ?? null, languages: patch.languages ?? "[]", visibility: patch.visibility ?? "private", createdAt: at, updatedAt: at });
    if (!ok) throw new HttpError(409, "That slug is taken", { code: "slug_taken" });
  } else {
    if (Object.keys(patch).length > 0 && !(await profiles.updateProfile(db, userId, { ...patch, updatedAt: at }))) throw new HttpError(409, "That slug is taken", { code: "slug_taken" });
  }
  return getMyProfile(db, userId);
}

export async function deleteMyProfile(db: D1Database, userId: string) {
  await me(db, userId);
  await profiles.deleteProfile(db, userId);
  await deletePageDetails(db, userId); // the page details and the card link go with the profile
  return { ok: true };
}

export async function putMyGame(db: D1Database, userId: string, gameRaw: string, b: Body) {
  await me(db, userId);
  const game = reqEnum(gameRaw, GAMES, "game");
  if (!(await profiles.getProfile(db, userId))) throw new HttpError(409, "Create your profile first", { code: "profile_required" });
  const inGameName = reqText(b.inGameName, "inGameName", 1, 40);
  const rankCode = optText(b.rankCode, "rankCode", 24);
  if (typeof rankCode === "string" && !/^[a-z0-9_]{1,24}$/.test(rankCode)) throw bad("rankCode must be lower-case letters, digits and underscores", "invalid_rankCode");
  const rankOrdinal = optInt(b.rankOrdinal, "rankOrdinal", 0, 100);
  const roles = enumArray(b.roles, PLAYER_ROLES, "roles", 4);
  await profiles.upsertGame(db, { userId, game, inGameName, rankCode: rankCode ?? null, rankOrdinal: rankOrdinal ?? null, roles: JSON.stringify(roles), updatedAt: nowSec() });
  return getMyProfile(db, userId);
}

export async function deleteMyGame(db: D1Database, userId: string, gameRaw: string) {
  await me(db, userId);
  const game = reqEnum(gameRaw, GAMES, "game");
  if (!(await profiles.deleteGame(db, userId, game))) throw new HttpError(404, "Not found");
  return getMyProfile(db, userId);
}

/** GET /public/players/:slug. Only a PUBLIC profile whose owner is 18+ confirmed AND consented AND active; anything else is the same 404. */
export async function publicPlayer(db: D1Database, slug: string) {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) throw new HttpError(404, "Not found");
  const r = await profiles.getProfileBySlugWithConsent(db, slug);
  if (!r || r.profile.visibility !== "public" || r.adultConfirmedAt === null || r.resumeConsentAt === null || r.userStatus !== "active") throw new HttpError(404, "Not found");
  return toPublicPlayer(r.profile, await profiles.listGames(db, r.profile.userId), await statsOf(db, r.profile.userId));
}

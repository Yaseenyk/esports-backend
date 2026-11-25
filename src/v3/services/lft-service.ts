/** Looking-for-Team board rules. Authorisation, caps, expiry, contact reveal and reporting live here; no SQL. */
import { HttpError } from "../../http";
import { AUTO_HIDE_AT, isReason, sanitiseNote } from "../../moderation/codes";
import { GAMES, LFT_KINDS, PLAYER_ROLES, isOneOf } from "../lib/enums";
import { newId, nowSec } from "../lib/ids";
import { validateApplicationMessage, validateContact, validateLftMessage } from "../lib/lft-text";
import { bad, enumArray, optBoolean, optEnum, optInt, optText, reqEnum } from "../lib/validate";
import * as flags from "../repositories/flag-repo";
import * as repo from "../repositories/lft-repo";
import * as users from "../repositories/user-repo";
import { decodeCursor, encodeCursor, toApplicationForApplicant, toApplicationForAuthor, toOwnListing, toPublicListing } from "../adapters/lft-adapter";
import { lftMatchEnabled } from "../repositories/flag-repo";
import * as match from "./lft-match-service";

type Body = Record<string, unknown>;

export const LFT = { OPEN_CAP: 3, DEFAULT_DAYS: 14, MAX_DAYS: 30, BUMP_GAP_SEC: 86_400, DELETE_AFTER_EXPIRY_SEC: 30 * 86_400, PAGE_DEFAULT: 20, PAGE_MAX: 50, REPORT_THRESHOLD: AUTO_HIDE_AT } as const;

async function requireAdult(db: D1Database, userId: string): Promise<void> {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (u.adultConfirmedAt === null) throw new HttpError(403, "Confirm that you are 18 or older to use the board", { code: "adult_required" });
}

function textOr400(r: ReturnType<typeof validateLftMessage>, field: string): string {
  if (r.ok) return r.text;
  const msg: Record<string, string> = {
    empty: `${field} is too short`, too_long: `${field} is too long`, has_link: `${field} must not contain links`, has_phone: `${field} must not contain phone numbers`,
    has_markup: `${field} must be plain text`,
    contact_outside: "Contact details are shared only after the poster accepts an application. Remove the handle or the \"DM me\" line and ask people to apply here.", bad_contact: `${field} must be a short handle (letters, digits . _ # @ -)`,
  };
  throw bad(msg[r.code] ?? `${field} is not valid`, `${field}_${r.code}`);
}

// ---------------- public ----------------
export async function publicList(db: D1Database, q: Record<string, string | undefined>) {
  if (await lftMatchEnabled(db)) return match.publicListMatch(db, q);
  const game = q.game === undefined ? undefined : reqEnum(q.game, GAMES, "game");
  const kind = q.kind === undefined ? undefined : reqEnum(q.kind, LFT_KINDS, "kind");
  const role = q.role === undefined ? undefined : reqEnum(q.role, PLAYER_ROLES, "role");
  const num = (v: string | undefined, field: string): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw bad(`${field} must be a whole number from 0 to 100`, `invalid_${field}`);
    return n;
  };
  const rankMin = num(q.rank_min, "rank_min");
  const rankMax = num(q.rank_max, "rank_max");
  if (rankMin !== undefined && rankMax !== undefined && rankMax < rankMin) throw bad("rank_max must not be below rank_min", "invalid_rank_range");
  const place = (v: string | undefined, field: string): string | undefined => {
    if (v === undefined || v === "") return undefined;
    if (v.length > 60 || /[<>]/.test(v)) throw bad(`${field} is not valid`, `invalid_${field}`);
    return v;
  };
  const cursor = decodeCursor(q.cursor);
  if (cursor === null) throw bad("cursor is not valid", "invalid_cursor");
  const limitN = q.limit === undefined ? LFT.PAGE_DEFAULT : Number(q.limit);
  if (!Number.isInteger(limitN) || limitN < 1) throw bad("limit must be a positive whole number", "invalid_limit");
  const limit = Math.min(limitN, LFT.PAGE_MAX);
  const rows = await repo.listPublic(db, { now: nowSec(), game, kind, role, rankMin, rankMax, state: place(q.state, "state"), city: place(q.city, "city"), onlineOk: q.online === "1" || q.online === "true", cursor, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(toPublicListing), nextCursor: rows.length > limit && last ? encodeCursor(last.last_bumped_at, last.id) : null };
}

export async function publicOne(db: D1Database, id: string) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, "Not found");
  const r = await repo.findPublicListing(db, id, nowSec());
  if (!r) throw new HttpError(404, "Not found");
  return toPublicListing(r);
}

// ---------------- author ----------------
export async function createListing(db: D1Database, userId: string, b: Body) {
  await requireAdult(db, userId);
  const kind = reqEnum(b.kind, LFT_KINDS, "kind");
  const game = reqEnum(b.game, GAMES, "game");
  const roles = enumArray(b.roles, PLAYER_ROLES, "roles", 4);
  const rankMin = optInt(b.rankMin, "rankMin", 0, 100);
  const rankMax = optInt(b.rankMax, "rankMax", 0, 100);
  if (typeof rankMin === "number" && typeof rankMax === "number" && rankMax < rankMin) throw bad("rankMax must not be below rankMin", "invalid_rank_range");
  const state = optText(b.state, "state", 60);
  const city = optText(b.city, "city", 60);
  const onlineOk = optBoolean(b.onlineOk, "onlineOk") ?? true;
  const message = textOr400(validateLftMessage(b.message), "message");
  const matchOn = await lftMatchEnabled(db);
  const prefs = matchOn ? match.readListingPrefs(b) : null;
  const contact = prefs?.contacts && (b.contact === undefined || b.contact === "") ? prefs.firstContact : textOr400(validateContact(b.contact), "contact");
  const days = optInt(b.expiresInDays, "expiresInDays", 1, LFT.MAX_DAYS) ?? LFT.DEFAULT_DAYS;

  let teamProfileId: string | null = null;
  if (kind === "looking_for_player") {
    if (typeof b.teamProfileId !== "string" || !/^[A-Za-z0-9._~-]{1,64}$/.test(b.teamProfileId)) throw bad("A looking_for_player post must name your team (teamProfileId)", "team_required");
    // Minimal rule: the author must OWN the team page (legacy team_profiles.owner_user_id) they recruit for.
    if (!(await repo.ownsTeamProfile(db, userId, b.teamProfileId))) throw new HttpError(403, "You can only recruit for a team page you own", { code: "not_team_owner" });
    teamProfileId = b.teamProfileId;
  } else if (b.teamProfileId !== undefined && b.teamProfileId !== null) {
    throw bad("A looking_for_team post must not name a team", "team_not_allowed");
  }

  const at = nowSec();
  const id = newId();
  const ok = await repo.insertListingCapped(db, { id, kind, authorUserId: userId, teamProfileId, game, roles: JSON.stringify(roles), rankMinOrdinal: rankMin ?? null, rankMaxOrdinal: rankMax ?? null, state: state ?? null, city: city ?? null, onlineOk, message, contact, expiresAt: at + days * 86_400, lastBumpedAt: at }, LFT.OPEN_CAP);
  if (!ok) throw new HttpError(409, `You can have at most ${LFT.OPEN_CAP} open listings`, { code: "listing_cap" });
  if (prefs) await match.saveListingPrefs(db, id, prefs);
  const own = toOwnListing((await repo.findListing(db, id))!);
  return matchOn ? { ...own, ...(await match.ownPrefs(db, id)) } : own;
}

export async function myListings(db: D1Database, userId: string) {
  const items = (await repo.listMine(db, userId)).map(toOwnListing);
  return { items: (await lftMatchEnabled(db)) ? await match.withOwnPrefs(db, items) : items };
}

async function ownListing(db: D1Database, userId: string, id: string) {
  const l = /^[0-9a-f]{32}$/.test(id) ? await repo.findListing(db, id) : null;
  if (!l || l.authorUserId !== userId) throw new HttpError(404, "Not found");
  return l;
}

export async function closeMyListing(db: D1Database, userId: string, id: string, b: Body) {
  const l = await ownListing(db, userId, id);
  const to = optEnum(b.status, ["closed", "filled"] as const, "status") ?? "closed";
  if (!(await repo.closeListing(db, l.id, to, nowSec()))) throw new HttpError(409, "Only an open listing can be closed", { code: "not_open" });
  return toOwnListing((await repo.findListing(db, l.id))!);
}

export async function bumpMyListing(db: D1Database, userId: string, id: string) {
  const l = await ownListing(db, userId, id);
  if (!(await repo.bumpListing(db, l.id, userId, nowSec(), LFT.BUMP_GAP_SEC))) {
    throw new HttpError(429, "A listing can be bumped once every 24 hours", { code: "bump_too_soon", retryAfter: Math.max(1, l.lastBumpedAt + LFT.BUMP_GAP_SEC - nowSec()) });
  }
  return toOwnListing((await repo.findListing(db, l.id))!);
}

// ---------------- applications ----------------
export async function applyToListing(db: D1Database, userId: string, listingId: string, b: Body) {
  await requireAdult(db, userId);
  const l = /^[0-9a-f]{32}$/.test(listingId) ? await repo.findPublicListing(db, listingId, nowSec()) : null;
  if (!l) throw new HttpError(404, "Not found");
  const full = (await repo.findListing(db, listingId))!;
  if (full.authorUserId === userId) throw new HttpError(403, "You cannot apply to your own listing", { code: "own_listing" });
  const matchOn = await lftMatchEnabled(db);
  // A block either way answers exactly like a listing that is gone.
  if (matchOn && (await match.blockedEitherWay(db, userId, full.authorUserId))) throw new HttpError(404, "Not found");
  const message = textOr400(validateApplicationMessage(b.message), "message");
  const chosen = matchOn ? match.readApplicationContacts(b) : null;
  const contact = chosen && (b.contact === undefined || b.contact === "") ? chosen.first : textOr400(validateContact(b.contact), "contact");
  const id = newId();
  if (!(await repo.insertApplication(db, { id, listingId, applicantUserId: userId, message, contact, createdAt: nowSec() }))) {
    throw new HttpError(409, "You have already applied to this listing", { code: "already_applied" });
  }
  if (chosen) await match.saveApplicationContacts(db, id, chosen.contacts);
  return { id, status: "sent" as const };
}

export async function listingApplications(db: D1Database, userId: string, listingId: string) {
  const l = await ownListing(db, userId, listingId);
  const items = (await repo.listApplicationsForListing(db, l.id)).map(toApplicationForAuthor);
  return { items: (await lftMatchEnabled(db)) ? await match.withApplicantContacts(db, items) : items };
}

export async function myApplications(db: D1Database, userId: string) {
  const items = (await repo.listMyApplications(db, userId)).map(toApplicationForApplicant);
  return { items: (await lftMatchEnabled(db)) ? await match.withListingContacts(db, items) : items };
}

export async function respondToApplication(db: D1Database, userId: string, applicationId: string, b: Body) {
  const a = /^[0-9a-f]{32}$/.test(applicationId) ? await repo.findApplication(db, applicationId) : null;
  const l = a ? await repo.findListing(db, a.listingId) : null;
  if (!a || !l || l.authorUserId !== userId) throw new HttpError(404, "Not found");
  const decision = reqEnum(b.decision, ["accept", "decline"] as const, "decision");
  if (!(await repo.setApplicationStatus(db, a.id, decision === "accept" ? "accepted" : "declined", nowSec()))) throw new HttpError(409, "This application is already answered", { code: "already_answered" });
  const fresh = toApplicationForAuthor((await repo.listApplicationsForListing(db, l.id)).find((x) => x.id === a.id)!);
  return (await lftMatchEnabled(db)) ? (await match.withApplicantContacts(db, [fresh]))[0]! : fresh;
}

export async function withdrawApplication(db: D1Database, userId: string, applicationId: string) {
  const a = /^[0-9a-f]{32}$/.test(applicationId) ? await repo.findApplication(db, applicationId) : null;
  if (!a || a.applicantUserId !== userId) throw new HttpError(404, "Not found");
  if (!(await repo.setApplicationStatus(db, a.id, "withdrawn", nowSec()))) throw new HttpError(409, "Only a pending application can be withdrawn", { code: "already_answered" });
  return { id: a.id, status: "withdrawn" as const };
}

// ---------------- reports ----------------
/**
 * A signed-in user reports a listing. The reporter is stored as a salted hash of the ACCOUNT, so one account counts once. At LFT.REPORT_THRESHOLD distinct
 * reporters the listing is hidden at once, pending moderator review, but only while flag takedown.enforce is on (the same rollout switch every other
 * takedown uses; reports are recorded either way). The answer never says whether the listing was hidden.
 */
export async function reportListing(db: D1Database, reporterHash: string, userId: string, listingId: string, b: Body) {
  const l = /^[0-9a-f]{32}$/.test(listingId) ? await repo.findListing(db, listingId) : null;
  if (!l || l.status !== "open") throw new HttpError(404, "Not found");
  if (l.authorUserId === userId) throw new HttpError(403, "You cannot report your own listing", { code: "own_listing" });
  if (!isReason(b.reason)) throw bad("reason is not one of the listed reasons", "invalid_reason");
  const enforce = await flags.takedownEnforced(db);
  await repo.fileListingReport(db, { id: newId(), listingId, reporter: reporterHash, reasonCode: b.reason, note: sanitiseNote(b.note), at: nowSec() }, LFT.REPORT_THRESHOLD, enforce);
  return { ok: true };
}

// ---------------- staff ----------------
export async function hiddenListings(db: D1Database) {
  const rows = await repo.listHidden(db);
  return { items: rows.map((r) => ({ id: r.id, kind: r.kind, game: r.game, message: r.message, reportCount: r.report_count, hiddenAt: new Date(r.hidden_at * 1000).toISOString() })) };
}
export async function decideListing(db: D1Database, id: string, decisionRaw: unknown) {
  if (!isOneOf(["restore", "remove"] as const, decisionRaw)) throw bad("decision must be restore or remove", "invalid_decision");
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, "Not found");
  const l = await repo.findListing(db, id);
  if (!l) throw new HttpError(404, "Not found");
  const at = nowSec();
  if (decisionRaw === "restore") {
    if (l.hiddenAt === null) throw new HttpError(409, "This listing is not hidden", { code: "not_hidden" });
    await repo.restoreListing(db, id, at);
  } else if (!(await repo.removeListing(db, id, at))) throw new HttpError(409, "Only an open listing can be removed", { code: "not_open" });
  return { ok: true, decision: decisionRaw };
}

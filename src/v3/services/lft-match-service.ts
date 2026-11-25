/**
 * LFT team matching (flag v3.lft_match; lft-service calls in here only while it is on). Language and play-hour filters, the "best match" sort, the
 * contacts each side chose to share (revealed only after an accept), blocks both ways, and reports on a request to join. No SQL here.
 */
import { HttpError } from "../../http";
import { isReason, sanitiseNote } from "../../moderation/codes";
import { GAMES, LFT_KINDS, PLAYER_ROLES } from "../lib/enums";
import { newId, nowSec, toIso, ID32_RE } from "../lib/ids";
import { CONTACT_KINDS, LANGUAGES, MATCH_POOL, PLAY_HOURS, checkContacts, codeList, csvCodes, matchScore, parseContacts, type Contacts } from "../lib/lft-match";
import { bad, enumArray, reqEnum } from "../lib/validate";
import * as repo from "../repositories/lft-repo";
import * as mrepo from "../repositories/lft-match-repo";
import { decodeCursor, encodeCursor, toPublicListing } from "../adapters/lft-adapter";

type Body = Record<string, unknown>;
const notFound = (): HttpError => new HttpError(404, "Not found");
const PAGE_DEFAULT = 20, PAGE_MAX = 50;

const CONTACT_MSG: Record<string, string> = {
  invalid_contacts: `contacts must be an object of up to 3 entries: ${CONTACT_KINDS.join(", ")}`,
  no_contacts: "Add at least one contact to share after an accept",
  too_many_contacts: "Share at most 3 contacts",
  bad_contact: "Each contact must be a short handle (letters, digits . _ # @ -)",
  has_link: "Contacts must not contain links",
  has_phone: "Contacts must not contain phone numbers",
};

function contactsOr400(v: unknown): { contacts: Contacts; first: string } {
  const c = checkContacts(v);
  if (!c.ok) throw bad(CONTACT_MSG[c.code] ?? "contacts are not valid", `contacts_${c.code}`);
  return { contacts: c.contacts, first: c.first };
}

// ---------------- listing facts ----------------
export interface ListingPrefs { languages: string[]; playHours: string[]; contacts: Contacts | null; firstContact: string }
/** Reads languages, playHours and contacts from a create body. Contacts are optional here (the legacy single `contact` still works). */
export function readListingPrefs(b: Body): ListingPrefs {
  const languages = enumArray(b.languages, LANGUAGES, "languages", 5);
  const playHours = enumArray(b.playHours, PLAY_HOURS, "playHours", 5);
  if (b.contacts === undefined || b.contacts === null) return { languages, playHours, contacts: null, firstContact: "" };
  const c = contactsOr400(b.contacts);
  return { languages, playHours, contacts: c.contacts, firstContact: c.first };
}
export async function saveListingPrefs(db: D1Database, listingId: string, p: ListingPrefs): Promise<void> {
  await mrepo.upsertPrefs(db, listingId, JSON.stringify(p.languages), JSON.stringify(p.playHours), JSON.stringify(p.contacts ?? {}));
}
export async function ownPrefs(db: D1Database, listingId: string) {
  const p = await mrepo.findPrefs(db, listingId);
  return { languages: codeList(p?.languages, LANGUAGES), playHours: codeList(p?.play_hours, PLAY_HOURS), contacts: parseContacts(p?.contacts) };
}
export async function withOwnPrefs<T extends { id: string }>(db: D1Database, items: T[]) {
  return Promise.all(items.map(async (i) => ({ ...i, ...(await ownPrefs(db, i.id)) })));
}

// ---------------- public board with matching ----------------
const num = (v: string | undefined, field: string): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw bad(`${field} must be a whole number from 0 to 100`, `invalid_${field}`);
  return n;
};
const place = (v: string | undefined, field: string): string | undefined => {
  if (v === undefined || v === "") return undefined;
  if (v.length > 60 || /[<>]/.test(v)) throw bad(`${field} is not valid`, `invalid_${field}`);
  return v;
};

/**
 * GET /public/lft while matching is on. Every earlier filter works as before, plus `lang` and `hours` (hard filters). `sort=match` ranks the newest
 * 100 matching listings by how well they fit `want_roles`, `want_langs` and `want_hours` (comma lists) and returns one page with no cursor.
 */
export async function publicListMatch(db: D1Database, q: Record<string, string | undefined>) {
  const game = q.game === undefined ? undefined : reqEnum(q.game, GAMES, "game");
  const kind = q.kind === undefined ? undefined : reqEnum(q.kind, LFT_KINDS, "kind");
  const role = q.role === undefined ? undefined : reqEnum(q.role, PLAYER_ROLES, "role");
  const language = q.lang === undefined || q.lang === "" ? undefined : reqEnum(q.lang, LANGUAGES, "lang");
  const hours = q.hours === undefined || q.hours === "" ? undefined : reqEnum(q.hours, PLAY_HOURS, "hours");
  const rankMin = num(q.rank_min, "rank_min");
  const rankMax = num(q.rank_max, "rank_max");
  if (rankMin !== undefined && rankMax !== undefined && rankMax < rankMin) throw bad("rank_max must not be below rank_min", "invalid_rank_range");
  const sort = q.sort === undefined || q.sort === "" ? "new" : reqEnum(q.sort, ["new", "match"] as const, "sort");
  const want = { roles: csvCodes(q.want_roles, PLAYER_ROLES, 4), languages: csvCodes(q.want_langs, LANGUAGES, 5), hours: csvCodes(q.want_hours, PLAY_HOURS, 5) };
  if (!want.roles || !want.languages || !want.hours) throw bad("want_roles, want_langs and want_hours must be short comma lists of known codes", "invalid_want");
  const cursor = sort === "match" ? undefined : decodeCursor(q.cursor);
  if (cursor === null) throw bad("cursor is not valid", "invalid_cursor");
  const limitN = q.limit === undefined ? PAGE_DEFAULT : Number(q.limit);
  if (!Number.isInteger(limitN) || limitN < 1) throw bad("limit must be a positive whole number", "invalid_limit");
  const limit = Math.min(limitN, PAGE_MAX);
  const base = { now: nowSec(), game, kind, role, rankMin, rankMax, state: place(q.state, "state"), city: place(q.city, "city"), onlineOk: q.online === "1" || q.online === "true", language, hours };
  const rows = await mrepo.listPublicWithPrefs(db, { ...base, cursor, limit: sort === "match" ? MATCH_POOL : limit + 1 });
  const items = rows.map((r) => {
    const facts = { roles: toPublicListing(r).roles, languages: codeList(r.languages, LANGUAGES), hours: codeList(r.play_hours, PLAY_HOURS) };
    return { ...toPublicListing(r), languages: facts.languages, playHours: facts.hours, match: matchScore({ roles: want.roles!, languages: want.languages!, hours: want.hours! }, facts), _ts: r.last_bumped_at };
  });
  if (sort === "match") {
    items.sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1) || b._ts - a._ts || (a.id < b.id ? 1 : -1));
    return { items: items.slice(0, limit).map(({ _ts, ...x }) => x), nextCursor: null, sort };
  }
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(({ _ts, ...x }) => x), nextCursor: items.length > limit && last ? encodeCursor(last._ts, last.id) : null, sort };
}

// ---------------- chosen contacts on a request ----------------
export function readApplicationContacts(b: Body): { contacts: Contacts; first: string } | null {
  if (b.contacts === undefined || b.contacts === null) return null;
  return contactsOr400(b.contacts);
}
export async function saveApplicationContacts(db: D1Database, applicationId: string, contacts: Contacts): Promise<void> {
  await mrepo.insertApplicationContacts(db, applicationId, JSON.stringify(contacts));
}
/** To the poster: the applicant's chosen contacts, ONLY on an accepted request (the legacy single contact follows the same rule in the adapter). */
export async function withApplicantContacts<T extends { id: string; status: string }>(db: D1Database, items: T[]) {
  const map = await mrepo.applicationContacts(db, items.filter((i) => i.status === "accepted").map((i) => i.id));
  return items.map((i) => ({ ...i, contacts: i.status === "accepted" ? parseContacts(map.get(i.id)) : null }));
}
/** To the applicant: the poster's chosen contacts, ONLY once their request was accepted. */
export async function withListingContacts<T extends { listingId: string; status: string }>(db: D1Database, items: T[]) {
  const map = await mrepo.listingContacts(db, items.filter((i) => i.status === "accepted").map((i) => i.listingId));
  return items.map((i) => ({ ...i, contacts: i.status === "accepted" ? parseContacts(map.get(i.listingId)) : null }));
}

export const blockedEitherWay = (db: D1Database, a: string, b: string): Promise<boolean> => mrepo.blockedEitherWay(db, a, b);

// ---------------- blocks ----------------
/** The request and its listing, when the caller is one of its two sides; otherwise the uniform 404. */
async function sideOf(db: D1Database, userId: string, applicationId: string) {
  const a = ID32_RE.test(applicationId) ? await repo.findApplication(db, applicationId) : null;
  const l = a ? await repo.findListing(db, a.listingId) : null;
  if (!a || !l) throw notFound();
  if (l.authorUserId === userId) return { a, l, side: "author" as const };
  if (a.applicantUserId === userId) return { a, l, side: "applicant" as const };
  throw notFound();
}

/**
 * POST /v3/lft-applications/:id/block. The poster blocks the applicant (their unanswered requests to any of the poster's listings are declined), or the
 * applicant blocks the poster (their own unanswered requests to that poster are withdrawn). Afterwards neither can send the other a request.
 */
export async function blockFromRequest(db: D1Database, userId: string, applicationId: string) {
  const { a, l, side } = await sideOf(db, userId, applicationId);
  const now = nowSec();
  if (side === "author") {
    await mrepo.insertBlock(db, { id: newId(), blocker: userId, blocked: a.applicantUserId, label: "A player who sent a request", at: now });
    await mrepo.declinePendingFrom(db, userId, a.applicantUserId, now);
  } else {
    await mrepo.insertBlock(db, { id: newId(), blocker: userId, blocked: l.authorUserId, label: l.kind === "looking_for_player" ? "A team you sent a request to" : "A player you sent a request to", at: now });
    await mrepo.withdrawPendingTo(db, userId, l.authorUserId, now);
  }
  return { ok: true, blocked: true };
}
export async function myBlocks(db: D1Database, userId: string) {
  return { items: (await mrepo.listBlocks(db, userId)).map((b) => ({ id: b.id, label: b.label, createdAt: toIso(b.created_at) })) };
}
export async function unblock(db: D1Database, userId: string, id: string) {
  if (!ID32_RE.test(id) || !(await mrepo.deleteBlock(db, id, userId))) throw notFound();
  return { ok: true };
}

// ---------------- reports on a request ----------------
/** POST /v3/lft-applications/:id/report: the POSTER reports a request to join (one report per account per request). Staff read them. */
export async function reportRequest(db: D1Database, reporterHash: string, userId: string, applicationId: string, b: Body) {
  const { side, a } = await sideOf(db, userId, applicationId);
  if (side !== "author") throw notFound();
  if (!isReason(b.reason)) throw bad("reason is not one of the listed reasons", "invalid_reason");
  await mrepo.fileApplicationReport(db, { id: newId(), applicationId: a.id, reporter: reporterHash, reasonCode: b.reason, note: sanitiseNote(b.note), at: nowSec() });
  return { ok: true };
}
export async function staffRequestReports(db: D1Database) {
  const rows = await mrepo.listApplicationReports(db, 100);
  return { items: rows.map((r) => ({ id: r.id, reason: r.reason_code, note: r.note, message: r.message ?? "", game: r.game, reportsOnApplicant: r.reports_on_applicant, createdAt: toIso(r.created_at) })) };
}

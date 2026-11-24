/**
 * College esports calendar rules. Who may list (a member of a VERIFIED organisation), what an entry may hold, what the public sees, and staff hide/restore.
 * No SQL here. Not found and not allowed answer the same 404.
 */
import { auditOff, auditStmts } from "../../audit";
import { HttpError } from "../../http";
import { CALENDAR, MODERATION_REASONS, addDays, cleanRegistrationUrl, daysBetween, parseDay, todayIst } from "../lib/community";
import { GAMES, isOneOf } from "../lib/enums";
import { ID32_RE, newId, nowSec } from "../lib/ids";
import { bad, optBoolean, optText, reqEnum, reqText } from "../lib/validate";
import * as repo from "../repositories/calendar-repo";
import * as users from "../repositories/user-repo";
import { toEntryAction, toOwnEntry, toPublicEntry } from "../adapters/community-adapter";

type Body = Record<string, unknown>;
const notFound = () => new HttpError(404, "Not found");

async function requireAdult(db: D1Database, userId: string): Promise<void> {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (u.adultConfirmedAt === null) throw new HttpError(403, "Confirm that you are 18 or older first", { code: "adult_required" });
}

// ---------------- public ----------------

/** GET /public/calendar. Filters: game, city, from / to (YYYY-MM-DD). Default: everything that has not ended yet. */
export async function publicCalendar(db: D1Database, q: Record<string, string | undefined>, nowMs: number = Date.now()) {
  const today = todayIst(nowMs);
  const game = q.game ? (isOneOf(GAMES, q.game) ? q.game : null) : null;
  if (q.game && !game) throw bad("game is not known", "invalid_game");
  const city = q.city ? q.city.trim().slice(0, 60) : null;
  const from = q.from ? parseDay(q.from) : today;
  const to = q.to ? parseDay(q.to) : null;
  if (!from || (q.to && !to)) throw bad("from and to must be dates (YYYY-MM-DD)", "invalid_dates");
  const [rows, upcoming] = await Promise.all([
    repo.listPublic(db, { from, to, game, city: city || null, limit: CALENDAR.LIST_MAX }),
    repo.countUpcomingVerified(db, today),
  ]);
  return { items: rows.map(toPublicEntry), upcomingVerified: upcoming, minimumForIndex: CALENDAR.MIN_UPCOMING_FOR_INDEX, today };
}

// ---------------- organiser ----------------

interface EntryInput { title: string; game: string; city: string; online: boolean; startsOn: string; endsOn: string; registrationUrl: string | null; urlStripped: boolean; tournamentSlug: string | null; status: "listed" | "cancelled" }

function parseEntry(b: Body, today: string): EntryInput {
  const title = reqText(b.title, "title", 3, 100);
  const game = reqEnum(b.game, GAMES, "game");
  const city = reqText(b.city, "city", 2, 60);
  const online = optBoolean(b.online, "online") ?? false;
  const startsOn = parseDay(b.startsOn);
  const endsOn = parseDay(b.endsOn ?? b.startsOn);
  if (!startsOn || !endsOn) throw bad("startsOn and endsOn must be dates (YYYY-MM-DD)", "invalid_dates");
  if (endsOn < startsOn) throw bad("The event cannot end before it starts", "invalid_dates");
  if (daysBetween(startsOn, endsOn) > CALENDAR.MAX_SPAN_DAYS - 1) throw bad(`An event can last at most ${CALENDAR.MAX_SPAN_DAYS} days`, "span_too_long");
  if (endsOn < today) throw bad("That event has already ended", "date_past");
  if (startsOn > addDays(today, CALENDAR.MAX_AHEAD_DAYS)) throw bad("That date is too far ahead", "too_far_ahead");
  let registrationUrl: string | null = null;
  let urlStripped = false;
  if (b.registrationUrl !== undefined && b.registrationUrl !== null && b.registrationUrl !== "") {
    if (typeof b.registrationUrl !== "string") throw bad("registrationUrl must be a link", "url_invalid");
    const u = cleanRegistrationUrl(b.registrationUrl);
    if (!u.ok) throw bad("That registration link cannot be used", u.code);
    registrationUrl = u.url;
    urlStripped = u.stripped;
  }
  let tournamentSlug: string | null = null;
  if (b.tournamentSlug !== undefined && b.tournamentSlug !== null && b.tournamentSlug !== "") {
    if (typeof b.tournamentSlug !== "string" || !/^[a-z0-9-]{1,80}$/.test(b.tournamentSlug)) throw bad("tournamentSlug is not valid", "tournament_not_found");
    tournamentSlug = b.tournamentSlug;
  }
  const status = b.status === undefined ? "listed" : reqEnum(b.status, ["listed", "cancelled"] as const, "status");
  if (!registrationUrl && !tournamentSlug && status !== "cancelled") throw bad("Add a registration link or one of your tournament pages", "link_required");
  return { title, game, city, online, startsOn, endsOn, registrationUrl, urlStripped, tournamentSlug, status };
}

async function tournamentIdFor(db: D1Database, orgId: string, slug: string | null): Promise<string | null> {
  if (!slug) return null;
  const t = await repo.orgTournamentBySlug(db, orgId, slug);
  if (!t) throw bad("That tournament page is not public or does not belong to this organisation", "tournament_not_found");
  return t.id;
}

/** GET /v3/me/calendar: the verified organisations the user can list for, and every entry of those organisations. */
export async function myCalendar(db: D1Database, userId: string) {
  const orgs = await repo.verifiedOrgsOf(db, userId);
  const rows = await repo.listForOrgs(db, orgs.map((o) => o.id));
  return { orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug })), items: rows.map(toOwnEntry) };
}

export async function createEntry(db: D1Database, userId: string, orgId: string, b: Body, nowMs: number = Date.now()) {
  if (!/^[A-Za-z0-9._~-]{1,48}$/.test(orgId)) throw notFound();
  await requireAdult(db, userId);
  const org = await repo.verifiedOrgOf(db, userId, orgId);
  if (!org) throw notFound();
  const today = todayIst(nowMs);
  const e = parseEntry(b, today);
  if (e.status === "cancelled") throw bad("A new entry cannot start cancelled", "invalid_status");
  if ((await repo.countUpcomingForOrg(db, org.id, today, "")) >= CALENDAR.MAX_UPCOMING_PER_ORG) throw new HttpError(409, `An organisation can list at most ${CALENDAR.MAX_UPCOMING_PER_ORG} upcoming events`, { code: "calendar_cap" });
  const tournamentId = await tournamentIdFor(db, org.id, e.tournamentSlug);
  const id = newId();
  await repo.insert(db, { id, orgId: org.id, title: e.title, game: e.game, city: e.city, online: e.online, startsOn: e.startsOn, endsOn: e.endsOn, registrationUrl: e.registrationUrl, tournamentId, createdBy: userId, at: nowSec() });
  const row = await repo.findById(db, id);
  return { entry: toOwnEntry(row!), urlStripped: e.urlStripped };
}

async function ownEntry(db: D1Database, userId: string, id: string) {
  if (!ID32_RE.test(id)) throw notFound();
  const row = await repo.findById(db, id);
  if (!row) throw notFound();
  const org = await repo.verifiedOrgOf(db, userId, row.org_id);
  if (!org) throw notFound();
  return row;
}

/** PUT /v3/calendar/:id: replaces the entry (send every field). A hidden entry stays hidden whatever is sent. */
export async function updateEntry(db: D1Database, userId: string, id: string, b: Body, nowMs: number = Date.now()) {
  const row = await ownEntry(db, userId, id);
  await requireAdult(db, userId);
  const today = todayIst(nowMs);
  const e = parseEntry(b, today);
  if (e.status === "listed" && row.status !== "listed" && (await repo.countUpcomingForOrg(db, row.org_id, today, row.id)) >= CALENDAR.MAX_UPCOMING_PER_ORG) {
    throw new HttpError(409, `An organisation can list at most ${CALENDAR.MAX_UPCOMING_PER_ORG} upcoming events`, { code: "calendar_cap" });
  }
  const tournamentId = await tournamentIdFor(db, row.org_id, e.tournamentSlug);
  await repo.update(db, row.id, { title: e.title, game: e.game, city: e.city, online: e.online, startsOn: e.startsOn, endsOn: e.endsOn, registrationUrl: e.registrationUrl, tournamentId, status: e.status, at: nowSec() });
  return { entry: toOwnEntry((await repo.findById(db, row.id))!), urlStripped: e.urlStripped };
}

export async function deleteEntry(db: D1Database, userId: string, id: string) {
  const row = await ownEntry(db, userId, id);
  await repo.remove(db, row.id);
  return { ok: true };
}

// ---------------- staff ----------------

function moderationInput(b: Body) {
  const reason = reqEnum(b.reason, MODERATION_REASONS, "reason");
  const note = optText(b.note, "note", 300) ?? "";
  return { reason, note };
}

export async function staffEntry(db: D1Database, id: string) {
  if (!ID32_RE.test(id)) throw notFound();
  const row = await repo.findById(db, id);
  if (!row) throw notFound();
  return { entry: toOwnEntry(row), actions: (await repo.actionsOf(db, id)).map(toEntryAction) };
}

export async function staffSetEntryHidden(db: D1Database, staffId: string, id: string, hide: boolean, b: Body) {
  if (!ID32_RE.test(id)) throw notFound();
  const row = await repo.findById(db, id);
  if (!row) throw notFound();
  const { reason, note } = moderationInput(b);
  if (hide && row.hidden_at !== null) throw new HttpError(409, "Already hidden", { code: "already_hidden" });
  if (!hide && row.hidden_at === null) throw new HttpError(409, "Not hidden", { code: "not_hidden" });
  const at = nowSec();
  const audit = auditStmts(db, { action: hide ? "calendar.hidden" : "calendar.restored", actorType: "staff", actorId: staffId, orgId: row.org_id, targetType: "calendar_entry", targetId: row.id, reasonCode: reason }, await auditOff(db));
  await repo.setHidden(db, row.id, hide ? { at, reason } : null, { id: newId(), action: hide ? "hidden" : "restored", reason, note, staffId, at }, audit);
  return staffEntry(db, row.id);
}

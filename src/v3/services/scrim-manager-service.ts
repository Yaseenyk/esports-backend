/**
 * Phase 4b (flag v3.scrims, migration 0057): the scrim MANAGER on top of the scrim finder. Rules only; no SQL.
 *  - Roster: who is in which slot number. The poster sees every team and its contact; a confirmed team sees the team names and numbers only.
 *  - Waitlist: on a FULL scrim a captain can join the waitlist. When a confirmed team drops (withdraws, or the poster removes it) or the poster adds
 *    seats, the next waiting team gets an OFFER in the platform (a notice on My scrims). It must accept within SCRIM_MANAGER.OFFER_WINDOW_SEC (never later
 *    than 5 minutes before the start); an unanswered offer expires and passes to the next team. Offers are processed on every read of the scrim and by the cron.
 *  - Recurring schedules: a template (time of day in IST, days ahead 1-7) that creates one slot per India day; each day can be edited or skipped.
 */
import { HttpError } from "../../http";
import { GAMES, SCRIM_REGIONS } from "../lib/enums";
import { ID32_RE, fromIso, newId, nowSec, toIso } from "../lib/ids";
import { addDays, isDay, isTimeOfDay, istDay, istToEpoch } from "../lib/ist";
import { hasEmail, validateApplicationMessage, validateContact, validatePublicNote, type TextCheck } from "../lib/lft-text";
import { bad, optBoolean, optInt, reqEnum } from "../lib/validate";
import * as flags from "../repositories/flag-repo";
import * as m from "../repositories/scrim-manager-repo";
import * as repo from "../repositories/scrim-repo";
import * as users from "../repositories/user-repo";
import { toPublicSlot } from "../adapters/scrim-adapter";
import { SCRIM_LIMITS as SCRIMS } from "../lib/scrim-limits";

type Body = Record<string, unknown>;
export const SCRIM_MANAGER = { OFFER_WINDOW_SEC: 30 * 60, OFFER_LAST_SEC: 5 * 60, SCHEDULE_CAP: 3, DAYS_DEFAULT: 3, TICK_SCHEDULES: 10, TICK_OFFERS: 20, NOTICE_RETENTION_SEC: 30 * 86_400 } as const;

const notFound = (): HttpError => new HttpError(404, "Not found");

async function requireAdult(db: D1Database, userId: string): Promise<void> {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (u.adultConfirmedAt === null) throw new HttpError(403, "Confirm that you are 18 or older to use the scrim finder", { code: "adult_required" });
}
function text(r: TextCheck, field: string): string {
  if (r.ok) return r.text;
  throw bad(`${field} is not valid (${r.code})`, `${field}_${r.code}`);
}
function contactOf(v: unknown): string {
  if (typeof v === "string" && hasEmail(v)) throw bad("Use a game or Discord handle, not an email address.", "contact_has_email");
  return text(validateContact(v), "contact");
}
async function ownTeam(db: D1Database, userId: string, v: unknown): Promise<string> {
  if (typeof v !== "string" || !/^[A-Za-z0-9._~-]{1,64}$/.test(v)) throw bad("Pick one of your team pages (teamProfileId)", "team_required");
  if ((await repo.ownedTeamName(db, userId, v)) === null) throw new HttpError(403, "You can only use a team page you own", { code: "not_team_owner" });
  return v;
}

// ---------------------------------------------------------------- offers (backfill)
/** Gives free seats to the next waiting teams as time-limited offers. Never throws for a missing slot. */
export async function backfill(db: D1Database, slotId: string, now: number = nowSec()): Promise<number> {
  const s = await repo.findSlot(db, slotId);
  if (!s || s.status !== "open" || s.hidden_at !== null || s.starts_at <= now) return 0;
  let free = s.slots_total - s.slots_filled - (await m.openOffers(db, slotId));
  const expires = Math.min(now + SCRIM_MANAGER.OFFER_WINDOW_SEC, s.starts_at - SCRIM_MANAGER.OFFER_LAST_SEC);
  if (expires <= now + 60) return 0; // too close to the start for anyone to answer
  let made = 0;
  while (free > 0) {
    const o = await m.offerNext(db, slotId, now, expires);
    if (!o) break;
    await m.notify(db, { id: newId(), userId: o.requester_user_id, kind: "waitlist_offer", slotId, at: now });
    free--; made++;
  }
  return made;
}
async function expireAndPass(db: D1Database, expired: { id: string; slot_id: string; request_id: string }[], now: number): Promise<void> {
  const slots = new Set<string>();
  for (const e of expired) {
    await m.closeRequestOfEntry(db, e.request_id, now);
    const q = await repo.findRequest(db, e.request_id);
    if (q) await m.notify(db, { id: newId(), userId: q.requester_user_id, kind: "offer_expired", slotId: e.slot_id, at: now });
    slots.add(e.slot_id);
  }
  for (const s of slots) await backfill(db, s, now);
}
/** Expire this scrim's late offers and offer the seats again. Called on every manager read and write of a scrim. */
export async function processSlot(db: D1Database, slotId: string, now: number = nowSec()): Promise<void> {
  await expireAndPass(db, await m.expireDueOffersOfSlot(db, slotId, now), now);
  await backfill(db, slotId, now);
}

/** Hooks called by the scrim finder service (scrim-service.ts) when its own actions change seats or requests. */
export async function onSeatFreed(db: D1Database, slotId: string): Promise<void> { await backfill(db, slotId); }
export async function onRequestAccepted(db: D1Database, requestId: string): Promise<void> {
  const e = await m.entryOfRequest(db, requestId);
  if (e) await m.setEntryStatus(db, e.id, ["waiting", "offered"], "accepted", nowSec());
}
export async function onRequestDeclined(db: D1Database, requestId: string): Promise<void> {
  const e = await m.entryOfRequest(db, requestId);
  if (e) await m.setEntryStatus(db, e.id, ["waiting", "offered"], "removed", nowSec());
}

// ---------------------------------------------------------------- roster
export async function roster(db: D1Database, userId: string, slotId: string) {
  const s = ID32_RE.test(slotId) ? await repo.findSlot(db, slotId) : null;
  if (!s) throw notFound();
  const now = nowSec();
  await processSlot(db, s.id, now);
  const fresh = (await repo.findSlot(db, s.id))!;
  const seats = await m.seats(db, s.id);
  const poster = s.poster_user_id === userId;
  if (!poster && !seats.some((x) => x.requester_user_id === userId)) throw notFound(); // only the poster and confirmed teams see the roster
  const wl = await m.waitlist(db, s.id);
  const taken = new Set(seats.map((x) => x.slot_no));
  return {
    slot: { ...toPublicSlot(fresh), status: fresh.status, expired: fresh.starts_at <= now },
    role: poster ? "poster" : "team",
    seats: seats.map((x) => ({ slotNo: x.slot_no, teamName: x.team_name ?? "Team", you: x.requester_user_id === userId, ...(poster ? { requestId: x.request_id, contact: x.contact } : {}) })),
    openSeats: Array.from({ length: fresh.slots_total }, (_, i) => i + 1).filter((n) => !taken.has(n)),
    waitlist: wl.map((e, i) => ({ position: i + 1, teamName: e.team_name ?? "Team", status: e.status, offerExpiresAt: toIso(e.offer_expires_at), you: e.requester_user_id === userId, ...(poster ? { requestId: e.request_id } : {}) })),
  };
}

// ---------------------------------------------------------------- waitlist
/** POST /v3/scrims/:id/waitlist: join the waitlist of a FULL scrim (a normal request when there is room). */
export async function joinWaitlist(db: D1Database, userId: string, slotId: string, b: Body) {
  await requireAdult(db, userId);
  const s = ID32_RE.test(slotId) ? await repo.findSlot(db, slotId) : null;
  if (!s || s.hidden_at !== null || (s.status !== "open" && s.status !== "full")) throw notFound();
  if (s.poster_user_id === userId) throw new HttpError(403, "You cannot join your own scrim", { code: "own_slot" });
  if (await repo.blockedEitherWay(db, userId, s.poster_user_id)) throw notFound();
  const now = nowSec();
  if (s.starts_at <= now) throw new HttpError(409, "This scrim has already started", { code: "slot_expired" });
  const free = s.slots_total - s.slots_filled - (await m.openOffers(db, s.id));
  if (s.status !== "full" && free > 0) throw new HttpError(409, "This scrim still has room: ask to join instead", { code: "slot_not_full" });
  const team = await ownTeam(db, userId, b.teamProfileId);
  const r = validateApplicationMessage(b.message);
  if (r.ok && Array.from(r.text).length > SCRIMS.MESSAGE_MAX) throw bad("message is too long", "message_too_long");
  const message = text(r, "message") || null;
  const contact = contactOf(b.contact);
  const requestId = newId();
  if (!(await repo.insertRequest(db, { id: requestId, slotId: s.id, requesterUserId: userId, teamProfileId: team, message, contact, at: now }))) {
    throw new HttpError(409, "You have already asked to join this scrim", { code: "already_requested" });
  }
  const id = newId();
  await m.insertEntry(db, { id, slotId: s.id, requestId, at: now });
  return { id, requestId, status: "waiting" as const };
}

export async function myWaitlist(db: D1Database, userId: string) {
  const now = nowSec();
  await expireAndPass(db, await m.expireDueOffers(db, now, SCRIM_MANAGER.TICK_OFFERS), now);
  const rows = await m.myEntries(db, userId);
  return {
    items: rows.map((e) => ({
      id: e.id, slotId: e.slot_id, status: e.status, position: e.status === "waiting" || e.status === "offered" ? e.position : null, offerExpiresAt: toIso(e.offer_expires_at),
      game: e.game, startsAt: toIso(e.starts_at), teamName: e.poster_team ?? "Team", myTeamName: e.team_name ?? "Team", slotStatus: e.slot_status,
    })),
  };
}

async function myEntry(db: D1Database, userId: string, id: string) {
  const e = ID32_RE.test(id) ? await m.findEntry(db, id) : null;
  if (!e || e.requester_user_id !== userId) throw notFound();
  return e;
}

export async function acceptOffer(db: D1Database, userId: string, id: string) {
  const e0 = await myEntry(db, userId, id);
  const now = nowSec();
  await processSlot(db, e0.slot_id, now);
  const e = (await m.findEntry(db, e0.id))!;
  if (e.status === "expired") throw new HttpError(409, "The time to accept this place has passed", { code: "offer_expired" });
  if (e.status !== "offered") throw new HttpError(409, "There is no open offer for you on this scrim", { code: "not_offered" });
  if (!(await m.acceptOffer(db, { id: e.id, requestId: e.request_id, slotId: e.slot_id }, now))) {
    await m.setEntryStatus(db, e.id, ["offered"], "waiting", now); // the seat went to someone else: back in the queue, first in line
    throw new HttpError(409, "Every slot was taken before you accepted", { code: "slot_full" });
  }
  return { id: e.id, status: "accepted" as const };
}

export async function declineOffer(db: D1Database, userId: string, id: string) {
  const e = await myEntry(db, userId, id);
  const now = nowSec();
  if (!(await m.setEntryStatus(db, e.id, ["offered"], "declined", now))) throw new HttpError(409, "There is no open offer for you on this scrim", { code: "not_offered" });
  await m.closeRequestOfEntry(db, e.request_id, now);
  await backfill(db, e.slot_id, now);
  return { id: e.id, status: "declined" as const };
}

export async function leaveWaitlist(db: D1Database, userId: string, id: string) {
  const e = await myEntry(db, userId, id);
  const now = nowSec();
  if (!(await m.setEntryStatus(db, e.id, ["waiting", "offered"], "left", now))) throw new HttpError(409, "You are not on this waitlist any more", { code: "not_waiting" });
  await repo.withdrawRequest(db, e.request_id, userId, now);
  await backfill(db, e.slot_id, now);
  return { id: e.id, status: "left" as const };
}

/** POST /v3/scrim-requests/:id/remove: the poster removes a confirmed team; its seat goes to the waitlist. */
export async function removeTeam(db: D1Database, userId: string, requestId: string) {
  const q = ID32_RE.test(requestId) ? await repo.findRequest(db, requestId) : null;
  const s = q ? await repo.findSlot(db, q.slot_id) : null;
  if (!q || !s || s.poster_user_id !== userId) throw notFound();
  const now = nowSec();
  if (!(await repo.removeAccepted(db, q.id, s.id, userId, now))) throw new HttpError(409, "Only a confirmed team can be removed", { code: "not_confirmed" });
  await m.notify(db, { id: newId(), userId: q.requester_user_id, kind: "removed_from_scrim", slotId: s.id, at: now });
  await backfill(db, s.id, now);
  return { id: q.id, status: "removed" as const };
}

/** PUT /v3/scrims/:id: the poster edits one scrim (one day of a schedule included). */
export async function editSlot(db: D1Database, userId: string, slotId: string, b: Body) {
  const s = ID32_RE.test(slotId) ? await repo.findSlot(db, slotId) : null;
  if (!s || s.poster_user_id !== userId) throw notFound();
  const now = nowSec();
  let startsAt = s.starts_at;
  if (b.startsAt !== undefined) {
    const t = fromIso(b.startsAt);
    if (t === null) throw bad("startsAt must be an ISO 8601 date and time", "invalid_startsAt");
    if (t < now + SCRIMS.MIN_LEAD_SEC) throw bad("A scrim must start at least 15 minutes from now", "starts_too_soon");
    if (t > now + SCRIMS.MAX_AHEAD_SEC) throw bad("A scrim can be set at most 30 days ahead", "starts_too_late");
    startsAt = t;
  }
  const slots = optInt(b.slots, "slots", 1, SCRIMS.SLOTS_MAX) ?? s.slots_total;
  if (slots < s.slots_filled) throw new HttpError(409, `${s.slots_filled} teams are already confirmed: remove one first`, { code: "below_confirmed" });
  const server = b.server === undefined ? s.server : text(validatePublicNote(b.server, SCRIMS.SERVER_MAX), "server") || null;
  const skillNote = b.skillNote === undefined ? s.skill_note : text(validatePublicNote(b.skillNote, SCRIMS.NOTE_MAX), "skillNote") || null;
  if (!(await repo.updateSlot(db, s.id, userId, { startsAt, server, skillNote, slotsTotal: slots }, now))) throw new HttpError(409, "Only an open scrim that has not started can be changed", { code: "not_open" });
  await backfill(db, s.id, now);
  return roster(db, userId, s.id);
}

// ---------------------------------------------------------------- notices
export async function myNotices(db: D1Database, userId: string) {
  const rows = await m.notices(db, userId);
  return { items: rows.map((n) => ({ id: n.id, kind: n.kind, slotId: n.slot_id, game: n.game, startsAt: toIso(n.starts_at), teamName: n.poster_team, read: n.read_at !== null, createdAt: toIso(n.created_at) })), unread: rows.filter((n) => n.read_at === null).length };
}
export async function readNotices(db: D1Database, userId: string) {
  await m.markNoticesRead(db, userId, nowSec());
  return { ok: true };
}

// ---------------------------------------------------------------- recurring schedules
function scheduleFields(b: Body, cur?: m.ScheduleRow) {
  const game = b.game === undefined && cur ? cur.game : reqEnum(b.game, GAMES, "game");
  const region = b.region === undefined && cur ? cur.region : reqEnum(b.region ?? "india", SCRIM_REGIONS, "region");
  const timeOfDay = b.timeOfDay === undefined && cur ? cur.time_of_day : b.timeOfDay;
  if (!isTimeOfDay(timeOfDay)) throw bad("timeOfDay must be HH:MM in India time (IST)", "invalid_timeOfDay");
  const daysAhead = optInt(b.daysAhead, "daysAhead", 1, 7) ?? cur?.days_ahead ?? SCRIM_MANAGER.DAYS_DEFAULT;
  const slots = optInt(b.slots, "slots", 1, SCRIMS.SLOTS_MAX) ?? cur?.slots_total;
  if (!slots) throw bad(`slots must be a whole number from 1 to ${SCRIMS.SLOTS_MAX}`, "invalid_slots");
  const server = b.server === undefined ? (cur?.server ?? null) : text(validatePublicNote(b.server, SCRIMS.SERVER_MAX), "server") || null;
  const skillNote = b.skillNote === undefined ? (cur?.skill_note ?? null) : text(validatePublicNote(b.skillNote, SCRIMS.NOTE_MAX), "skillNote") || null;
  const contact = b.contact === undefined && cur ? cur.contact : contactOf(b.contact);
  const active = optBoolean(b.active, "active");
  return { game, region, time_of_day: timeOfDay, days_ahead: daysAhead, slots_total: slots, server, skill_note: skillNote, contact, active: active === undefined ? (cur?.active ?? 1) : active ? 1 : 0 };
}

/** Creates the missing days of one schedule (today and the next days_ahead - 1 India days). Days already made or skipped are never touched. */
export async function generate(db: D1Database, sc: m.ScheduleRow, now: number = nowSec()): Promise<number> {
  if (sc.active !== 1) return 0;
  let made = 0;
  const today = istDay(now);
  for (let i = 0; i < sc.days_ahead; i++) {
    const day = addDays(today, i);
    const startsAt = istToEpoch(day, sc.time_of_day);
    if (startsAt < now + SCRIMS.MIN_LEAD_SEC) continue;
    if (await m.generateDay(db, sc, day, newId(), startsAt, now)) made++;
  }
  return made;
}

async function scheduleView(db: D1Database, sc: m.ScheduleRow, now: number) {
  const days = await m.scheduleDays(db, sc.id, istDay(now));
  return {
    id: sc.id, teamProfileId: sc.team_profile_id, teamName: sc.team_name ?? "Team", game: sc.game, timeOfDay: sc.time_of_day, timeZone: "Asia/Kolkata", daysAhead: sc.days_ahead, region: sc.region,
    server: sc.server, skillNote: sc.skill_note, slots: sc.slots_total, contact: sc.contact, active: sc.active === 1, createdAt: toIso(sc.created_at),
    days: days.map((d) => ({ day: d.day, skipped: d.skipped === 1, slotId: d.slot_id, startsAt: toIso(d.starts_at), status: d.slot_status, confirmed: d.slots_filled, slots: d.slots_total })),
  };
}

export async function createSchedule(db: D1Database, userId: string, b: Body) {
  await requireAdult(db, userId);
  const team = await ownTeam(db, userId, b.teamProfileId);
  const f = scheduleFields(b);
  const id = newId();
  const now = nowSec();
  if (!(await m.insertScheduleCapped(db, { id, poster_user_id: userId, team_profile_id: team, ...f, at: now }, SCRIM_MANAGER.SCHEDULE_CAP))) {
    throw new HttpError(409, `You can have at most ${SCRIM_MANAGER.SCHEDULE_CAP} recurring scrims`, { code: "schedule_cap" });
  }
  const sc = (await m.findSchedule(db, id))!;
  await generate(db, sc, now);
  return scheduleView(db, sc, now);
}

export async function mySchedules(db: D1Database, userId: string) {
  const now = nowSec();
  const rows = await m.schedulesOf(db, userId);
  for (const sc of rows) await generate(db, sc, now);
  return { items: await Promise.all(rows.map((sc) => scheduleView(db, sc, now))) };
}

async function ownSchedule(db: D1Database, userId: string, id: string) {
  const sc = ID32_RE.test(id) ? await m.findSchedule(db, id) : null;
  if (!sc || sc.poster_user_id !== userId) throw notFound();
  return sc;
}

/** PUT /v3/scrim-schedules/:id: the template changes for days made from now on (pause with active: false). Days already made keep their own settings. */
export async function updateSchedule(db: D1Database, userId: string, id: string, b: Body) {
  const sc = await ownSchedule(db, userId, id);
  const team = b.teamProfileId === undefined ? sc.team_profile_id : await ownTeam(db, userId, b.teamProfileId);
  const f = scheduleFields(b, sc);
  const now = nowSec();
  await m.updateSchedule(db, sc.id, userId, { team_profile_id: team, ...f }, now);
  const fresh = (await m.findSchedule(db, sc.id))!;
  await generate(db, fresh, now);
  return scheduleView(db, fresh, now);
}

export async function deleteSchedule(db: D1Database, userId: string, id: string) {
  const sc = await ownSchedule(db, userId, id);
  await m.deleteSchedule(db, sc.id, userId, nowSec());
  return { ok: true };
}

/** POST /v3/scrim-schedules/:id/days/:day/skip: no scrim that day. A made slot is cancelled (confirmed teams see it as cancelled). */
export async function skipScheduleDay(db: D1Database, userId: string, id: string, day: string) {
  const sc = await ownSchedule(db, userId, id);
  const now = nowSec();
  const today = istDay(now);
  if (!isDay(day) || day < today || day > addDays(today, 30)) throw bad("day must be an India date (YYYY-MM-DD) from today on", "invalid_day");
  const slotId = await m.skipDay(db, sc.id, day);
  if (slotId) await repo.cancelSlot(db, slotId, userId, now);
  return scheduleView(db, sc, now);
}

// ---------------------------------------------------------------- cron
/** Every cron tick, only while v3.scrims is on: late offers expire and pass on, recurring schedules make their missing days. Bounded per tick. */
export async function runManagerTick(db: D1Database, opts: { daily: boolean; now?: number }): Promise<{ expired: number; generated: number; noticesDeleted: number }> {
  const out = { expired: 0, generated: 0, noticesDeleted: 0 };
  const now = opts.now ?? nowSec();
  if (opts.daily) out.noticesDeleted = await m.deleteOldNotices(db, now - SCRIM_MANAGER.NOTICE_RETENTION_SEC); // retention runs whatever the flag says
  if (!(await flags.scrimsEnabled(db))) return out;
  const expired = await m.expireDueOffers(db, now, SCRIM_MANAGER.TICK_OFFERS);
  out.expired = expired.length;
  await expireAndPass(db, expired, now);
  for (const sc of await m.activeSchedules(db, SCRIM_MANAGER.TICK_SCHEDULES)) {
    out.generated += await generate(db, sc, now);
    await m.touchSchedule(db, sc.id, now);
  }
  return out;
}

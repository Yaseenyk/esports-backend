/**
 * Phase 4 (flag v3.scrims): the scrim finder. Rules, authorisation, caps, expiry, contact reveal, blocks and reporting live here; no SQL.
 *  - Posting and requesting need the 18+ confirmation and a team page the caller owns (that is what "captain" means here).
 *  - Times are stored in UTC (epoch seconds). A slot must start at least 15 minutes and at most 30 days from now. Past slots leave the board at once and are
 *    deleted 7 days after they start.
 *  - Contact is a short platform handle (no links, phone numbers or email addresses), revealed only after the poster accepts a request, and only to the two sides.
 *  - Blocks work both ways: neither side sees the other's slots on the signed-in board, and a blocked captain cannot request (the answer is a plain 404).
 */
import { HttpError } from "../../http";
import { AUTO_HIDE_AT, hidesAtOnce, isReason, sanitiseNote } from "../../moderation/codes";
import { GAMES, SCRIM_REGIONS, isOneOf } from "../lib/enums";
import { ID32_RE, fromIso, newId, nowSec } from "../lib/ids";
import { hasEmail, validateApplicationMessage, validateContact, validatePublicNote, type TextCheck } from "../lib/lft-text";
import { bad, optInt, reqEnum } from "../lib/validate";
import * as flags from "../repositories/flag-repo";
import * as repo from "../repositories/scrim-repo";
import * as users from "../repositories/user-repo";
import { SCRIM_LIMITS } from "../lib/scrim-limits";
import { onRequestAccepted, onRequestDeclined, onSeatFreed } from "./scrim-manager-service";
import { decodeCursor, encodeCursor, toOwnSlot, toPublicSlot, toRequestForPoster, toRequestForRequester, toViewerSlot } from "../adapters/scrim-adapter";

type Body = Record<string, unknown>;

export const SCRIMS = { ...SCRIM_LIMITS, OPEN_CAP: 5, DELETE_AFTER_START_SEC: 7 * 86_400, PAGE_DEFAULT: 20, PAGE_MAX: 50, REPORT_THRESHOLD: AUTO_HIDE_AT } as const;

const notFound = (): HttpError => new HttpError(404, "Not found");

async function requireAdult(db: D1Database, userId: string): Promise<void> {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (u.adultConfirmedAt === null) throw new HttpError(403, "Confirm that you are 18 or older to use the scrim finder", { code: "adult_required" });
}

function textOr400(r: TextCheck, field: string): string {
  if (r.ok) return r.text;
  const msg: Record<string, string> = {
    empty: `${field} is too short`, too_long: `${field} is too long`, has_link: `${field} must not contain links`, has_phone: `${field} must not contain phone numbers`,
    has_markup: `${field} must be plain text`, bad_contact: `${field} must be a short handle (letters, digits . _ # @ -)`,
    contact_outside: "Contact details are shared only after a request is accepted. Remove the handle or the \"DM me\" line.",
  };
  throw bad(msg[r.code] ?? `${field} is not valid`, `${field}_${r.code}`);
}

/** A platform handle only: the LFT contact rules plus no email address. */
function contactOf(v: unknown): string {
  if (typeof v === "string" && hasEmail(v)) throw bad("Use a game or Discord handle, not an email address. Contact details are shared only after a request is accepted.", "contact_has_email");
  const c = textOr400(validateContact(v), "contact");
  if (hasEmail(c)) throw bad("Use a game or Discord handle, not an email address. Contact details are shared only after a request is accepted.", "contact_has_email");
  return c;
}

async function ownTeam(db: D1Database, userId: string, v: unknown): Promise<{ id: string; name: string }> {
  if (typeof v !== "string" || !/^[A-Za-z0-9._~-]{1,64}$/.test(v)) throw bad("Pick one of your team pages (teamProfileId)", "team_required");
  const name = await repo.ownedTeamName(db, userId, v);
  if (name === null) throw new HttpError(403, "You can only use a team page you own", { code: "not_team_owner" });
  return { id: v, name };
}

// ---------------------------------------------------------------- board
function boardFilter(q: Record<string, string | undefined>) {
  const game = q.game === undefined || q.game === "" ? undefined : reqEnum(q.game, GAMES, "game");
  const region = q.region === undefined || q.region === "" ? undefined : reqEnum(q.region, SCRIM_REGIONS, "region");
  const time = (v: string | undefined, field: string): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const s = fromIso(v);
    if (s === null) throw bad(`${field} must be an ISO 8601 date`, `invalid_${field}`);
    return s;
  };
  const from = time(q.from, "from");
  const to = time(q.to, "to");
  if (from !== undefined && to !== undefined && to <= from) throw bad("to must be after from", "invalid_range");
  const cursor = decodeCursor(q.cursor);
  if (cursor === null) throw bad("cursor is not valid", "invalid_cursor");
  const n = q.limit === undefined ? SCRIMS.PAGE_DEFAULT : Number(q.limit);
  if (!Number.isInteger(n) || n < 1) throw bad("limit must be a positive whole number", "invalid_limit");
  return { now: nowSec(), game, region, from, to, cursor, limit: Math.min(n, SCRIMS.PAGE_MAX) };
}
const page = <T extends { starts_at: number; id: string }>(rows: T[], limit: number) => {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.starts_at, last.id) : null };
};

/** GET /public/scrims: open upcoming slots with room, soonest first. */
export async function publicBoard(db: D1Database, q: Record<string, string | undefined>) {
  const f = boardFilter(q);
  const p = page(await repo.listPublic(db, { ...f, limit: f.limit + 1 }), f.limit);
  return { items: p.items.map(toPublicSlot), nextCursor: p.nextCursor };
}
/** GET /v3/scrims: the board for a signed-in captain (blocks applied both ways, own slots and requests marked). */
export async function viewerBoard(db: D1Database, userId: string, q: Record<string, string | undefined>) {
  const f = boardFilter(q);
  const p = page(await repo.listForViewer(db, { ...f, limit: f.limit + 1 }, userId), f.limit);
  return { items: p.items.map(toViewerSlot), nextCursor: p.nextCursor };
}
export async function publicSlot(db: D1Database, id: string) {
  const s = ID32_RE.test(id) ? await repo.findPublicSlot(db, id, nowSec()) : null;
  if (!s) throw notFound();
  return toPublicSlot(s);
}

// ---------------------------------------------------------------- poster
export async function createSlot(db: D1Database, userId: string, b: Body) {
  await requireAdult(db, userId);
  const team = await ownTeam(db, userId, b.teamProfileId);
  const game = reqEnum(b.game, GAMES, "game");
  const region = reqEnum(b.region, SCRIM_REGIONS, "region");
  const startsAt = fromIso(b.startsAt);
  const at = nowSec();
  if (startsAt === null) throw bad("startsAt must be an ISO 8601 date and time (UTC or with an offset)", "invalid_startsAt");
  if (startsAt < at + SCRIMS.MIN_LEAD_SEC) throw bad("A scrim must start at least 15 minutes from now", "starts_too_soon");
  if (startsAt > at + SCRIMS.MAX_AHEAD_SEC) throw bad("A scrim can be posted at most 30 days ahead", "starts_too_late");
  const slots = optInt(b.slots, "slots", 1, SCRIMS.SLOTS_MAX);
  if (slots === undefined || slots === null) throw bad(`slots must be a whole number from 1 to ${SCRIMS.SLOTS_MAX}`, "invalid_slots");
  const server = textOr400(validatePublicNote(b.server, SCRIMS.SERVER_MAX), "server") || null;
  const skillNote = textOr400(validatePublicNote(b.skillNote, SCRIMS.NOTE_MAX), "skillNote") || null;
  const contact = contactOf(b.contact);
  const id = newId();
  const ok = await repo.insertSlotCapped(db, { id, posterUserId: userId, teamProfileId: team.id, game, startsAt, region, server, skillNote, slotsTotal: slots, contact, at }, SCRIMS.OPEN_CAP);
  if (!ok) throw new HttpError(409, `You can have at most ${SCRIMS.OPEN_CAP} open scrim slots`, { code: "slot_cap" });
  const mine = (await repo.listMine(db, userId)).find((s) => s.id === id)!;
  return toOwnSlot(mine, at);
}

export async function mySlots(db: D1Database, userId: string) {
  const now = nowSec();
  return { items: (await repo.listMine(db, userId)).map((s) => toOwnSlot(s, now)) };
}

async function ownSlot(db: D1Database, userId: string, id: string): Promise<repo.SlotRow> {
  const s = ID32_RE.test(id) ? await repo.findSlot(db, id) : null;
  if (!s || s.poster_user_id !== userId) throw notFound();
  return s;
}

export async function cancelMySlot(db: D1Database, userId: string, id: string) {
  const s = await ownSlot(db, userId, id);
  if (!(await repo.cancelSlot(db, s.id, userId, nowSec()))) throw new HttpError(409, "Only an open slot that has not started can be cancelled", { code: "not_open" });
  return { id: s.id, status: "cancelled" as const };
}

export async function slotRequests(db: D1Database, userId: string, id: string) {
  const s = await ownSlot(db, userId, id);
  return { items: (await repo.requestsForSlot(db, s.id)).map(toRequestForPoster) };
}

// ---------------------------------------------------------------- requester
export async function requestSlot(db: D1Database, userId: string, slotId: string, b: Body) {
  await requireAdult(db, userId);
  const s = ID32_RE.test(slotId) ? await repo.findSlot(db, slotId) : null;
  if (!s || s.hidden_at !== null || (s.status !== "open" && s.status !== "full")) throw notFound();
  if (s.poster_user_id === userId) throw new HttpError(403, "You cannot request your own slot", { code: "own_slot" });
  if (await repo.blockedEitherWay(db, userId, s.poster_user_id)) throw notFound();
  const at = nowSec();
  if (s.starts_at <= at) throw new HttpError(409, "This scrim has already started", { code: "slot_expired" });
  if (s.status === "full" || s.slots_filled >= s.slots_total) throw new HttpError(409, "This scrim is full", { code: "slot_full" });
  const team = await ownTeam(db, userId, b.teamProfileId);
  const r = validateApplicationMessage(b.message);
  if (r.ok && Array.from(r.text).length > SCRIMS.MESSAGE_MAX) throw bad("message is too long", "message_too_long");
  const message = textOr400(r, "message") || null;
  const contact = contactOf(b.contact);
  const id = newId();
  if (!(await repo.insertRequest(db, { id, slotId: s.id, requesterUserId: userId, teamProfileId: team.id, message, contact, at }))) {
    throw new HttpError(409, "You have already asked to join this scrim", { code: "already_requested" });
  }
  return { id, status: "sent" as const };
}

export async function myRequests(db: D1Database, userId: string) {
  return { items: (await repo.myRequests(db, userId)).map(toRequestForRequester) };
}

async function requestOnMySlot(db: D1Database, userId: string, requestId: string) {
  const q = ID32_RE.test(requestId) ? await repo.findRequest(db, requestId) : null;
  const s = q ? await repo.findSlot(db, q.slot_id) : null;
  if (!q || !s || s.poster_user_id !== userId) throw notFound();
  return { q, s };
}

export async function respondToRequest(db: D1Database, userId: string, requestId: string, b: Body) {
  const { q, s } = await requestOnMySlot(db, userId, requestId);
  const decision = reqEnum(b.decision, ["accept", "decline"] as const, "decision");
  const at = nowSec();
  if (q.status !== "sent") throw new HttpError(409, "This request is already answered", { code: "already_answered" });
  if (decision === "accept") {
    if (s.starts_at <= at) throw new HttpError(409, "This scrim has already started", { code: "slot_expired" });
    if (!(await repo.acceptRequest(db, q.id, s.id, at))) {
      const fresh = await repo.findSlot(db, s.id);
      if (fresh && (fresh.status === "full" || fresh.slots_filled >= fresh.slots_total)) throw new HttpError(409, "Every slot is taken", { code: "slot_full" });
      throw new HttpError(409, "This request can no longer be accepted", { code: "already_answered" });
    }
    await onRequestAccepted(db, q.id);
  } else {
    if (!(await repo.declineRequest(db, q.id, at))) throw new HttpError(409, "This request is already answered", { code: "already_answered" });
    await onRequestDeclined(db, q.id);
  }
  const fresh = (await repo.requestsForSlot(db, s.id)).find((x) => x.id === q.id)!;
  return toRequestForPoster(fresh);
}

export async function withdrawMyRequest(db: D1Database, userId: string, requestId: string) {
  const q = ID32_RE.test(requestId) ? await repo.findRequest(db, requestId) : null;
  if (!q || q.requester_user_id !== userId) throw notFound();
  if (!(await repo.withdrawRequest(db, q.id, userId, nowSec()))) throw new HttpError(409, "Only a pending or accepted request can be withdrawn", { code: "already_answered" });
  await onRequestDeclined(db, q.id); // a waitlist entry of this request leaves the queue too
  if (q.status === "accepted") await onSeatFreed(db, q.slot_id); // the seat goes to the next team on the waitlist
  return { id: q.id, status: "withdrawn" as const };
}

// ---------------------------------------------------------------- blocks
/** POST /v3/scrims/:id/block: the caller blocks the captain who posted this slot. */
export async function blockPoster(db: D1Database, userId: string, slotId: string) {
  const s = ID32_RE.test(slotId) ? await repo.findSlot(db, slotId) : null;
  if (!s) throw notFound();
  if (s.poster_user_id === userId) throw bad("You cannot block yourself", "own_slot");
  await repo.insertBlock(db, { id: newId(), blocker: userId, blocked: s.poster_user_id, label: (s.team_name ?? "Team").slice(0, 60), at: nowSec() });
  return { ok: true };
}
/** POST /v3/scrim-requests/:id/block: the poster blocks the captain who sent this request; that captain's unanswered requests to the poster are declined. */
export async function blockRequester(db: D1Database, userId: string, requestId: string) {
  const { q } = await requestOnMySlot(db, userId, requestId);
  const at = nowSec();
  const label = (await repo.ownedTeamName(db, q.requester_user_id, q.team_profile_id)) ?? "Team";
  await repo.insertBlock(db, { id: newId(), blocker: userId, blocked: q.requester_user_id, label: label.slice(0, 60), at });
  await repo.declinePendingFrom(db, userId, q.requester_user_id, at);
  await onRequestDeclined(db, q.id);
  return { ok: true };
}
export async function myBlocks(db: D1Database, userId: string) {
  return { items: (await repo.listBlocks(db, userId)).map((b) => ({ id: b.id, label: b.label, createdAt: new Date(b.created_at * 1000).toISOString() })) };
}
export async function unblock(db: D1Database, userId: string, id: string) {
  if (!ID32_RE.test(id) || !(await repo.deleteBlock(db, id, userId))) throw notFound();
  return { ok: true };
}

// ---------------------------------------------------------------- reports and staff
export async function reportSlot(db: D1Database, reporter: string, userId: string, slotId: string, b: Body) {
  const s = ID32_RE.test(slotId) ? await repo.findSlot(db, slotId) : null;
  if (!s || (s.status !== "open" && s.status !== "full")) throw notFound();
  if (s.poster_user_id === userId) throw new HttpError(403, "You cannot report your own slot", { code: "own_slot" });
  if (!isReason(b.reason)) throw bad("reason is not one of the listed reasons", "invalid_reason");
  const enforce = await flags.takedownEnforced(db);
  await repo.fileSlotReport(db, { id: newId(), slotId: s.id, reporter, reasonCode: b.reason, note: sanitiseNote(b.note), at: nowSec() }, SCRIMS.REPORT_THRESHOLD, enforce, hidesAtOnce(b.reason));
  return { ok: true };
}

export async function hiddenSlots(db: D1Database) {
  return {
    items: (await repo.listHidden(db)).map((s) => ({ id: s.id, game: s.game, startsAt: new Date(s.starts_at * 1000).toISOString(), teamName: s.team_name, skillNote: s.skill_note, status: s.status, reportCount: s.report_count, hiddenAt: new Date(s.hidden_at * 1000).toISOString() })),
  };
}
export async function decideSlot(db: D1Database, id: string, decisionRaw: unknown) {
  if (!isOneOf(["restore", "remove"] as const, decisionRaw)) throw bad("decision must be restore or remove", "invalid_decision");
  if (!ID32_RE.test(id)) throw notFound();
  const s = await repo.findSlot(db, id);
  if (!s) throw notFound();
  const at = nowSec();
  if (decisionRaw === "restore") {
    if (!(await repo.restoreSlot(db, id, at))) throw new HttpError(409, "This slot is not hidden", { code: "not_hidden" });
  } else if (!(await repo.removeSlot(db, id, at))) throw new HttpError(409, "Only an open slot can be removed", { code: "not_open" });
  return { ok: true, decision: decisionRaw };
}

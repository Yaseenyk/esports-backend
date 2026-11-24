/**
 * Match rooms (flag v3.rooms): the organiser stores a custom-room ID and password once; the captains of CONFIRMED teams of that match can read them
 * from the reveal time, and every read is logged. No SQL here.
 *
 * Who may do what
 *  - organiser (owner, editor or org admin of the event, the existing access layer): create, edit timing, rotate, delete, read the view log.
 *    A view-only guest may list rooms (no credentials ever) and gets 403 on a change. No access: 404. The organiser never reads the credentials back.
 *  - captain: a signed-in, 18+ user who proved captaincy with the team's captain link (v3_team_captains), whose team is confirmed (approved registration
 *    or roster team) and who plays the room (every team for an event-wide room, the two teams for a match room). Anyone else: 404.
 *  - before reveal_at: 403 `not_yet` (with the reveal time). 24 hours after the start the ciphertext is deleted: 410 `expired`.
 * Secrets: the key is the Worker secret ROOM_CREDENTIALS_KEY; missing or short = 503 `rooms_not_configured` (nothing is stored without it).
 */
import { HttpError } from "../../http";
import { newId, nowSec } from "../lib/ids";
import { openRoomSecret, roomKeyConfigured, sealRoomSecret } from "../lib/room-crypto";
import { ROOMS, cleanCredential, revealAtFrom, roomPhase } from "../lib/rooms";
import { bad, optDate, optInt, reqText } from "../lib/validate";
import { toCaptainRoom, toOrganiserRoom, toRevealed, toView } from "../adapters/room-adapter";
import { loadEventAccess } from "../repositories/event-access-repo";
import { captainTokenTeam, claimCaptain, teamIsRegistered } from "../repositories/dispute-repo";
import * as repo from "../repositories/room-repo";
import { getUserV3, setAdultConfirmed } from "../repositories/user-repo";

type Body = Record<string, unknown>;

async function organiser(db: D1Database, userId: string, eventId: string, write: boolean) {
  const a = await loadEventAccess(db, userId, eventId);
  if (!a) throw new HttpError(404, "Event not found");
  if (write && !a.canWrite) throw new HttpError(403, "You can view this event but not change it");
  return a;
}
const notConfigured = () => new HttpError(503, "Room sharing is not set up on this server yet", { code: "rooms_not_configured" });
function keyOf(secret: string | undefined): string {
  if (!roomKeyConfigured(secret)) throw notConfigured();
  return secret;
}
const ROOM_ID_RE = /^[0-9a-f]{32}$/;
function roomIdParam(id: string): string {
  if (!ROOM_ID_RE.test(id)) throw new HttpError(404, "Not found");
  return id;
}
function credential(v: unknown, field: "roomId" | "password"): string {
  const t = cleanCredential(v);
  if (t === null) throw bad(`${field} must be 1-${ROOMS.CRED_MAX} characters on one line`, `invalid_${field}`);
  return t;
}
function minutesBefore(v: unknown, dflt: number): number {
  const m = optInt(v, "revealMinutesBefore", 0, ROOMS.REVEAL_MAX_MIN);
  return m === undefined || m === null ? dflt : m;
}
function startsAtOf(v: unknown, now: number, required: boolean): number | undefined {
  const s = optDate(v, "startsAt");
  if (s === undefined || s === null) {
    if (required) throw bad("startsAt is required", "invalid_startsAt");
    return undefined;
  }
  if (s <= now - ROOMS.PURGE_AFTER_SEC) throw bad("startsAt is more than 24 hours ago", "invalid_startsAt");
  return s;
}
async function matchIdOf(db: D1Database, eventId: string, v: unknown): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9._~-]{1,64}$/.test(v) || !(await repo.matchExists(db, eventId, v))) throw bad("matchId is not a match of this event", "invalid_matchId");
  return v;
}

// ---------------- organiser ----------------
export async function listEventRooms(db: D1Database, userId: string, eventId: string) {
  const a = await organiser(db, userId, eventId, false);
  const now = nowSec();
  const [rooms, matches] = await Promise.all([repo.listRooms(db, eventId), repo.eventMatches(db, eventId)]);
  return {
    event: { id: a.eventId, name: a.name },
    canEdit: a.canWrite,
    rooms: rooms.map((r) => toOrganiserRoom(r, now)),
    matches: matches.map((m) => ({ id: m.id, stage: m.stage, round: m.round, slot: m.slot, teamA: m.a, teamB: m.b })),
    limits: { revealMaxMinutes: ROOMS.REVEAL_MAX_MIN, revealDefaultMinutes: ROOMS.REVEAL_DEFAULT_MIN, credentialMax: ROOMS.CRED_MAX, maxRooms: ROOMS.MAX_PER_EVENT },
  };
}

export async function createRoom(db: D1Database, keySecret: string | undefined, userId: string, eventId: string, b: Body) {
  await organiser(db, userId, eventId, true);
  const key = keyOf(keySecret);
  const now = nowSec();
  const label = reqText(b.label, "label", 1, ROOMS.LABEL_MAX);
  const startsAt = startsAtOf(b.startsAt, now, true)!;
  const revealAt = revealAtFrom(startsAt, minutesBefore(b.revealMinutesBefore, ROOMS.REVEAL_DEFAULT_MIN));
  const matchId = (await matchIdOf(db, eventId, b.matchId)) ?? null;
  const roomId = credential(b.roomId, "roomId");
  const password = credential(b.password, "password");
  if ((await repo.countRooms(db, eventId)) >= ROOMS.MAX_PER_EVENT) throw new HttpError(409, `An event can have at most ${ROOMS.MAX_PER_EVENT} rooms`, { code: "room_limit" });
  const id = newId();
  const secretEnc = await sealRoomSecret(key, { roomId: id, eventId }, { roomId, password });
  await repo.insertRoom(db, { id, eventId, matchId, label, startsAt, revealAt, secretEnc, createdBy: userId, at: now });
  return toOrganiserRoom((await repo.getRoom(db, eventId, id))!, now);
}

export async function updateRoom(db: D1Database, userId: string, eventId: string, roomIdRaw: string, b: Body) {
  await organiser(db, userId, eventId, true);
  const id = roomIdParam(roomIdRaw);
  const cur = await repo.getRoom(db, eventId, id);
  if (!cur) throw new HttpError(404, "Not found");
  if ("roomId" in b || "password" in b) throw bad("Change the room ID or password with rotate", "use_rotate");
  const now = nowSec();
  const label = b.label === undefined ? cur.label : reqText(b.label, "label", 1, ROOMS.LABEL_MAX);
  const startsAt = startsAtOf(b.startsAt, now, false) ?? cur.starts_at;
  const mins = minutesBefore(b.revealMinutesBefore, Math.round((cur.starts_at - cur.reveal_at) / 60));
  const m = await matchIdOf(db, eventId, b.matchId);
  await repo.updateRoomMeta(db, eventId, id, { label, matchId: m === undefined ? cur.match_id : m, startsAt, revealAt: revealAtFrom(startsAt, mins), at: now });
  return toOrganiserRoom((await repo.getRoom(db, eventId, id))!, now);
}

/** New password (and optionally a new room ID). Without a room ID the current one is kept, which needs the current ciphertext. */
export async function rotateRoom(db: D1Database, keySecret: string | undefined, userId: string, eventId: string, roomIdRaw: string, b: Body) {
  await organiser(db, userId, eventId, true);
  const key = keyOf(keySecret);
  const id = roomIdParam(roomIdRaw);
  const cur = await repo.getRoom(db, eventId, id);
  if (!cur) throw new HttpError(404, "Not found");
  const password = credential(b.password, "password");
  let roomId: string;
  if (b.roomId !== undefined && b.roomId !== null && b.roomId !== "") roomId = credential(b.roomId, "roomId");
  else {
    const sealed = await repo.secretFor(db, id);
    const open = sealed ? await openRoomSecret(key, { roomId: id, eventId }, sealed) : null;
    if (!open) throw bad("Type the room ID as well: the old one is no longer stored", "room_id_required");
    roomId = open.roomId;
  }
  const now = nowSec();
  await repo.replaceSecret(db, eventId, id, await sealRoomSecret(key, { roomId: id, eventId }, { roomId, password }), now);
  return toOrganiserRoom((await repo.getRoom(db, eventId, id))!, now);
}

export async function removeRoom(db: D1Database, userId: string, eventId: string, roomIdRaw: string) {
  await organiser(db, userId, eventId, true);
  if (!(await repo.deleteRoom(db, eventId, roomIdParam(roomIdRaw)))) throw new HttpError(404, "Not found");
  return { ok: true };
}

/** The audit log of one room: which team's captain revealed it, when, and which rotation they saw. Organisers (any role on the event) only. */
export async function roomViews(db: D1Database, userId: string, eventId: string, roomIdRaw: string) {
  await organiser(db, userId, eventId, false);
  const id = roomIdParam(roomIdRaw);
  const cur = await repo.getRoom(db, eventId, id);
  if (!cur) throw new HttpError(404, "Not found");
  return { room: { id: cur.id, label: cur.label, version: cur.secret_version }, views: (await repo.listViews(db, id, ROOMS.VIEWS_LIMIT)).map(toView) };
}

// ---------------- captain ----------------
async function requireAdult(db: D1Database, userId: string, adult: unknown): Promise<void> {
  const u = await getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (u.adultConfirmedAt !== null) return;
  if (adult !== true) throw new HttpError(403, "Confirm you are 18 or older first", { code: "adult_required" });
  await setAdultConfirmed(db, userId, nowSec());
}

/** A signed-in user proves they captain a team with the team's captain link. The token is never stored. Only a confirmed team can be claimed. */
export async function claimRoomCaptain(db: D1Database, userId: string, b: Body) {
  await requireAdult(db, userId, b.adult);
  const token = b.token;
  if (typeof token !== "string" || token.length > 128) throw bad("token is required", "token_required");
  const c = await captainTokenTeam(db, token);
  if (!c) throw new HttpError(404, "That captain link is not valid", { code: "bad_token" });
  if (!(await teamIsRegistered(db, c.eventId, c.team))) throw new HttpError(409, "That team is not confirmed in this event yet", { code: "team_not_confirmed" });
  await claimCaptain(db, c.eventId, c.team, userId, nowSec());
  return { team: c.team };
}

export async function myRooms(db: D1Database, userId: string) {
  const now = nowSec();
  const rows = await repo.captainRooms(db, userId, 300);
  return { rooms: rows.filter((r) => roomPhase({ revealAt: r.reveal_at, startsAt: r.starts_at, purgedAt: r.purged_at }, now) !== "expired").map((r) => toCaptainRoom(r, now)) };
}

/** The credentials, for an allowed captain at or after the reveal time. Each successful read is written to the audit log. */
export async function revealRoom(db: D1Database, keySecret: string | undefined, userId: string, roomIdRaw: string) {
  const id = roomIdParam(roomIdRaw);
  const row = await repo.captainForRoom(db, userId, id);
  if (!row) throw new HttpError(404, "Not found");
  const now = nowSec();
  const phase = roomPhase({ revealAt: row.reveal_at, startsAt: row.starts_at, purgedAt: row.purged_at }, now);
  if (phase === "expired") throw new HttpError(410, "This room has ended and its details were deleted", { code: "expired" });
  if (phase === "waiting") throw new HttpError(403, "The room details are not shown yet", { code: "not_yet", revealAt: new Date(row.reveal_at * 1000).toISOString() });
  const key = keyOf(keySecret);
  const sealed = await repo.secretFor(db, id);
  const open = sealed ? await openRoomSecret(key, { roomId: id, eventId: row.event_id }, sealed) : null;
  if (!open) throw new HttpError(410, "The room details are not available. Ask the organiser.", { code: "unavailable" });
  await repo.insertView(db, { id: newId(), roomId: id, eventId: row.event_id, userId, teamName: row.team_name, version: row.secret_version, at: now });
  return toRevealed(row, open);
}

/** Retention: deletes the ciphertext 24 hours after the start. Safe before migration 0070 (does nothing). */
export async function purgeRoomSecrets(db: D1Database, now = nowSec()): Promise<number> {
  if (!(await repo.roomTablesExist(db))) return 0;
  return repo.purgeDue(db, now, ROOMS.PURGE_AFTER_SEC);
}

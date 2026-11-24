/**
 * v3_match_rooms and v3_room_views (migration 0070), plus the legacy reads the room rules need (matches, approved registrations, roster teams,
 * v3_team_captains). The only place these tables are queried. A repository never decides who may see a row: the SQL below returns the facts
 * (is this user a proven captain of a confirmed team that plays this room?) and services/room-service.ts decides.
 * `secret_enc` is selected ONLY by `secretFor`; every list reads `secret_enc IS NOT NULL` instead, so a list can never carry ciphertext.
 */
export interface RoomRow {
  id: string;
  event_id: string;
  match_id: string | null;
  label: string;
  starts_at: number;
  reveal_at: number;
  has_secret: number;
  secret_version: number;
  rotated_at: number | null;
  purged_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface RoomListRow extends RoomRow { views: number; teams_seen_current: number; match_a: string | null; match_b: string | null }
export interface CaptainRoomRow extends RoomRow { team_name: string; event_name: string; match_a: string | null; match_b: string | null }
export interface ViewRow { team_name: string; secret_version: number; viewed_at: number }

// Every statement below is a constant string (test/hardening.test.ts forbids building SQL from variables), so the shared parts are repeated:
//  - the room columns read `(r.secret_enc IS NOT NULL) AS has_secret`, never the ciphertext;
//  - CONFIRMED: the captain's team has an approved registration or is a roster team of the event;
//  - PLAYS: the room is for every team (match_id NULL) or the captain's team is one of the two teams of that match (a deleted match = nobody).

export async function roomTablesExist(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'v3_match_rooms'").first()) !== null;
}

export async function countRooms(db: D1Database, eventId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM v3_match_rooms WHERE event_id = ?1").bind(eventId).first<{ n: number }>())?.n ?? 0;
}

export interface NewRoom { id: string; eventId: string; matchId: string | null; label: string; startsAt: number; revealAt: number; secretEnc: string; createdBy: string; at: number }
export async function insertRoom(db: D1Database, r: NewRoom): Promise<void> {
  await db
    .prepare("INSERT INTO v3_match_rooms (id, event_id, match_id, label, starts_at, reveal_at, secret_enc, secret_version, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?9)")
    .bind(r.id, r.eventId, r.matchId, r.label, r.startsAt, r.revealAt, r.secretEnc, r.createdBy, r.at)
    .run();
}

export async function getRoom(db: D1Database, eventId: string, roomId: string): Promise<(RoomRow & { match_a: string | null; match_b: string | null }) | null> {
  return (
    (await db
      .prepare("SELECT r.id, r.event_id, r.match_id, r.label, r.starts_at, r.reveal_at, (r.secret_enc IS NOT NULL) AS has_secret, r.secret_version, r.rotated_at, r.purged_at, r.created_at, r.updated_at, m.a AS match_a, m.b AS match_b FROM v3_match_rooms r LEFT JOIN matches m ON m.id = r.match_id AND m.event_id = r.event_id WHERE r.event_id = ?1 AND r.id = ?2")
      .bind(eventId, roomId)
      .first<RoomRow & { match_a: string | null; match_b: string | null }>()) ?? null
  );
}

export async function listRooms(db: D1Database, eventId: string): Promise<RoomListRow[]> {
  const r = await db
    .prepare(
      `SELECT r.id, r.event_id, r.match_id, r.label, r.starts_at, r.reveal_at, (r.secret_enc IS NOT NULL) AS has_secret, r.secret_version, r.rotated_at, r.purged_at, r.created_at, r.updated_at, m.a AS match_a, m.b AS match_b,
        (SELECT COUNT(*) FROM v3_room_views v WHERE v.room_id = r.id) AS views,
        (SELECT COUNT(DISTINCT lower(v.team_name)) FROM v3_room_views v WHERE v.room_id = r.id AND v.secret_version = r.secret_version) AS teams_seen_current
       FROM v3_match_rooms r LEFT JOIN matches m ON m.id = r.match_id AND m.event_id = r.event_id
       WHERE r.event_id = ?1 ORDER BY r.starts_at, r.created_at LIMIT 200`,
    )
    .bind(eventId)
    .all<RoomListRow>();
  return r.results;
}

export async function updateRoomMeta(db: D1Database, eventId: string, roomId: string, p: { label: string; matchId: string | null; startsAt: number; revealAt: number; at: number }): Promise<void> {
  await db
    .prepare("UPDATE v3_match_rooms SET label = ?3, match_id = ?4, starts_at = ?5, reveal_at = ?6, updated_at = ?7 WHERE event_id = ?1 AND id = ?2")
    .bind(eventId, roomId, p.label, p.matchId, p.startsAt, p.revealAt, p.at)
    .run();
}

/** Replaces the ciphertext. A rotation bumps secret_version (views of the old version stay in the log) and clears a purge. */
export async function replaceSecret(db: D1Database, eventId: string, roomId: string, secretEnc: string, at: number): Promise<void> {
  await db
    .prepare("UPDATE v3_match_rooms SET secret_enc = ?3, secret_version = secret_version + 1, rotated_at = ?4, purged_at = NULL, updated_at = ?4 WHERE event_id = ?1 AND id = ?2")
    .bind(eventId, roomId, secretEnc, at)
    .run();
}

export async function deleteRoom(db: D1Database, eventId: string, roomId: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM v3_match_rooms WHERE event_id = ?1 AND id = ?2").bind(eventId, roomId).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** The ciphertext of one room (the only read of secret_enc). */
export async function secretFor(db: D1Database, roomId: string): Promise<string | null> {
  return (await db.prepare("SELECT secret_enc FROM v3_match_rooms WHERE id = ?1").bind(roomId).first<{ secret_enc: string | null }>())?.secret_enc ?? null;
}

export async function listViews(db: D1Database, roomId: string, limit: number): Promise<ViewRow[]> {
  const r = await db.prepare("SELECT team_name, secret_version, viewed_at FROM v3_room_views WHERE room_id = ?1 ORDER BY viewed_at DESC LIMIT ?2").bind(roomId, limit).all<ViewRow>();
  return r.results;
}

export async function insertView(db: D1Database, v: { id: string; roomId: string; eventId: string; userId: string; teamName: string; version: number; at: number }): Promise<void> {
  await db
    .prepare("INSERT INTO v3_room_views (id, room_id, event_id, user_id, team_name, secret_version, viewed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(v.id, v.roomId, v.eventId, v.userId, v.teamName, v.version, v.at)
    .run();
}

/** The legacy matches of an event, for the organiser's "which match" picker (team names only). */
export async function eventMatches(db: D1Database, eventId: string): Promise<{ id: string; stage: string; round: number; slot: number; a: string; b: string }[]> {
  const r = await db.prepare("SELECT id, stage, round, slot, a, b FROM matches WHERE event_id = ?1 ORDER BY stage, round, slot LIMIT 500").bind(eventId).all<{ id: string; stage: string; round: number; slot: number; a: string; b: string }>();
  return r.results;
}
export async function matchExists(db: D1Database, eventId: string, matchId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM matches WHERE event_id = ?1 AND id = ?2").bind(eventId, matchId).first()) !== null;
}

/** Rooms of every event where the user is a proven captain of a confirmed team that plays the room. No ciphertext. */
export async function captainRooms(db: D1Database, userId: string, limit: number): Promise<CaptainRoomRow[]> {
  const r = await db
    .prepare(
      `SELECT r.id, r.event_id, r.match_id, r.label, r.starts_at, r.reveal_at, (r.secret_enc IS NOT NULL) AS has_secret, r.secret_version, r.rotated_at, r.purged_at, r.created_at, r.updated_at, c.team_name AS team_name, e.name AS event_name, m.a AS match_a, m.b AS match_b
       FROM v3_team_captains c
       JOIN v3_match_rooms r ON r.event_id = c.event_id
       JOIN events e ON e.id = c.event_id
       LEFT JOIN matches m ON m.id = r.match_id AND m.event_id = r.event_id
       WHERE c.user_id = ?1 AND (EXISTS (SELECT 1 FROM registrations g WHERE g.event_id = c.event_id AND lower(g.team_name) = c.team_key AND g.status = 'approved') OR EXISTS (SELECT 1 FROM teams t WHERE t.event_id = c.event_id AND lower(t.name) = c.team_key)) AND (r.match_id IS NULL OR (m.id IS NOT NULL AND (lower(m.a) = c.team_key OR lower(m.b) = c.team_key)))
       ORDER BY r.starts_at, r.id LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<CaptainRoomRow>();
  return r.results;
}

/** The same check for one room: the captain row (team name) when the user may see it, or null. */
export async function captainForRoom(db: D1Database, userId: string, roomId: string): Promise<CaptainRoomRow | null> {
  return (
    (await db
      .prepare(
        `SELECT r.id, r.event_id, r.match_id, r.label, r.starts_at, r.reveal_at, (r.secret_enc IS NOT NULL) AS has_secret, r.secret_version, r.rotated_at, r.purged_at, r.created_at, r.updated_at, c.team_name AS team_name, e.name AS event_name, m.a AS match_a, m.b AS match_b
         FROM v3_match_rooms r
         JOIN v3_team_captains c ON c.event_id = r.event_id AND c.user_id = ?1
         JOIN events e ON e.id = r.event_id
         LEFT JOIN matches m ON m.id = r.match_id AND m.event_id = r.event_id
         WHERE r.id = ?2 AND (EXISTS (SELECT 1 FROM registrations g WHERE g.event_id = c.event_id AND lower(g.team_name) = c.team_key AND g.status = 'approved') OR EXISTS (SELECT 1 FROM teams t WHERE t.event_id = c.event_id AND lower(t.name) = c.team_key)) AND (r.match_id IS NULL OR (m.id IS NOT NULL AND (lower(m.a) = c.team_key OR lower(m.b) = c.team_key)))
         ORDER BY c.team_name LIMIT 1`,
      )
      .bind(userId, roomId)
      .first<CaptainRoomRow>()) ?? null
  );
}

/** Deletes the ciphertext of every room whose start is more than `afterSec` ago. Returns how many rooms were purged. */
export async function purgeDue(db: D1Database, now: number, afterSec: number): Promise<number> {
  const r = await db.prepare("UPDATE v3_match_rooms SET secret_enc = NULL, purged_at = ?1 WHERE purged_at IS NULL AND starts_at <= ?2").bind(now, now - afterSec).run();
  return r.meta?.changes ?? 0;
}

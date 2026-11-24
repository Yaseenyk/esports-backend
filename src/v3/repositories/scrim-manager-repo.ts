/**
 * Phase 4b (migration 0057): the scrim manager. The only place scrim_slot_assignments, scrim_waitlist, scrim_notifications, scrim_schedules and
 * scrim_schedule_days are queried. Decides nothing about who may see a row (services/scrim-manager-service.ts does). Constant SQL only.
 */

export async function managerTablesExist(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'scrim_waitlist'").first()) !== null;
}

/** The statement that gives an ACCEPTED request the lowest free slot number (part of the accept batch in scrim-repo). Idempotent. */
export function assignSeatStatement(db: D1Database, requestId: string, slotId: string, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO scrim_slot_assignments (slot_id, slot_no, request_id, created_at)
       SELECT ?2, CASE WHEN NOT EXISTS (SELECT 1 FROM scrim_slot_assignments WHERE slot_id = ?2 AND slot_no = 1) THEN 1
         ELSE (SELECT MIN(a.slot_no + 1) FROM scrim_slot_assignments a WHERE a.slot_id = ?2 AND NOT EXISTS (SELECT 1 FROM scrim_slot_assignments b WHERE b.slot_id = ?2 AND b.slot_no = a.slot_no + 1)) END, ?1, ?3
       WHERE (SELECT status FROM scrim_requests WHERE id = ?1) = 'accepted' AND NOT EXISTS (SELECT 1 FROM scrim_slot_assignments WHERE request_id = ?1)`,
    )
    .bind(requestId, slotId, at);
}
/** Frees the seat of a request that is no longer accepted. */
export const releaseSeatStatement = (db: D1Database, requestId: string): D1PreparedStatement =>
  db.prepare("DELETE FROM scrim_slot_assignments WHERE request_id = ?1 AND (SELECT status FROM scrim_requests WHERE id = ?1) != 'accepted'").bind(requestId);

// ---------------------------------------------------------------- roster and waitlist
export interface SeatRow { slot_no: number; request_id: string; team_name: string | null; contact: string; requester_user_id: string }
export async function seats(db: D1Database, slotId: string): Promise<SeatRow[]> {
  return (
    await db
      .prepare("SELECT a.slot_no, a.request_id, tp.name AS team_name, q.contact, q.requester_user_id FROM scrim_slot_assignments a JOIN scrim_requests q ON q.id = a.request_id LEFT JOIN team_profiles tp ON tp.id = q.team_profile_id WHERE a.slot_id = ?1 ORDER BY a.slot_no LIMIT 24")
      .bind(slotId)
      .all<SeatRow>()
  ).results;
}
export interface EntryRow { id: string; slot_id: string; request_id: string; status: string; offered_at: number | null; offer_expires_at: number | null; created_at: number; team_name: string | null; requester_user_id: string }
export async function waitlist(db: D1Database, slotId: string): Promise<EntryRow[]> {
  return (
    await db
      .prepare("SELECT w.id, w.slot_id, w.request_id, w.status, w.offered_at, w.offer_expires_at, w.created_at, tp.name AS team_name, q.requester_user_id FROM scrim_waitlist w JOIN scrim_requests q ON q.id = w.request_id LEFT JOIN team_profiles tp ON tp.id = q.team_profile_id WHERE w.slot_id = ?1 AND w.status IN ('waiting','offered') ORDER BY w.created_at, w.rowid LIMIT 100")
      .bind(slotId)
      .all<EntryRow>()
  ).results;
}
export async function findEntry(db: D1Database, id: string): Promise<EntryRow | null> {
  return (
    (await db
      .prepare("SELECT w.id, w.slot_id, w.request_id, w.status, w.offered_at, w.offer_expires_at, w.created_at, tp.name AS team_name, q.requester_user_id FROM scrim_waitlist w JOIN scrim_requests q ON q.id = w.request_id LEFT JOIN team_profiles tp ON tp.id = q.team_profile_id WHERE w.id = ?1")
      .bind(id)
      .first<EntryRow>()) ?? null
  );
}
export interface MyEntryRow extends EntryRow { game: string; starts_at: number; poster_team: string | null; slot_status: string; position: number }
export async function myEntries(db: D1Database, userId: string): Promise<MyEntryRow[]> {
  return (
    await db
      .prepare(
        `SELECT w.id, w.slot_id, w.request_id, w.status, w.offered_at, w.offer_expires_at, w.created_at, mt.name AS team_name, q.requester_user_id, s.game, s.starts_at, pt.name AS poster_team, s.status AS slot_status,
           (SELECT COUNT(*) FROM scrim_waitlist x WHERE x.slot_id = w.slot_id AND x.status IN ('waiting','offered') AND (x.created_at < w.created_at OR (x.created_at = w.created_at AND x.rowid <= w.rowid))) AS position
         FROM scrim_waitlist w JOIN scrim_requests q ON q.id = w.request_id JOIN scrim_slots s ON s.id = w.slot_id LEFT JOIN team_profiles mt ON mt.id = q.team_profile_id LEFT JOIN team_profiles pt ON pt.id = s.team_profile_id
         WHERE q.requester_user_id = ?1 ORDER BY s.starts_at DESC LIMIT 100`,
      )
      .bind(userId)
      .all<MyEntryRow>()
  ).results;
}
export async function insertEntry(db: D1Database, e: { id: string; slotId: string; requestId: string; at: number }): Promise<void> {
  await db.prepare("INSERT INTO scrim_waitlist (id, slot_id, request_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'waiting', ?4, ?4)").bind(e.id, e.slotId, e.requestId, e.at).run();
}
/** Moves an entry between states atomically (only from one of `from`). */
export async function setEntryStatus(db: D1Database, id: string, from: readonly string[], to: string, at: number): Promise<boolean> {
  const r = await db.prepare("UPDATE scrim_waitlist SET status = ?3, updated_at = ?4 WHERE id = ?1 AND status IN (SELECT value FROM json_each(?2))").bind(id, JSON.stringify(from), to, at).run();
  return (r.meta?.changes ?? 0) === 1;
}
/** Entry of a request (for "the poster declined this request" and withdrawals). */
export async function entryOfRequest(db: D1Database, requestId: string): Promise<{ id: string; status: string } | null> {
  return (await db.prepare("SELECT id, status FROM scrim_waitlist WHERE request_id = ?1").bind(requestId).first<{ id: string; status: string }>()) ?? null;
}

/** Offers the oldest waiting entry of a slot (status waiting -> offered with a deadline). Returns it, or null when nobody waits. */
export async function offerNext(db: D1Database, slotId: string, at: number, expires: number): Promise<{ id: string; requester_user_id: string } | null> {
  const r = await db
    .prepare(
      `UPDATE scrim_waitlist SET status = 'offered', offered_at = ?2, offer_expires_at = ?3, updated_at = ?2
       WHERE id = (SELECT w.id FROM scrim_waitlist w JOIN scrim_requests q ON q.id = w.request_id WHERE w.slot_id = ?1 AND w.status = 'waiting' AND q.status = 'sent' ORDER BY w.created_at, w.rowid LIMIT 1)
       RETURNING id, request_id`,
    )
    .bind(slotId, at, expires)
    .all<{ id: string; request_id: string }>();
  const row = r.results[0];
  if (!row) return null;
  const who = await db.prepare("SELECT requester_user_id FROM scrim_requests WHERE id = ?1").bind(row.request_id).first<{ requester_user_id: string }>();
  return who ? { id: row.id, requester_user_id: who.requester_user_id } : null;
}
export async function openOffers(db: D1Database, slotId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM scrim_waitlist WHERE slot_id = ?1 AND status = 'offered'").bind(slotId).first<{ n: number }>())?.n ?? 0;
}
/** Offers past their deadline become expired (at most `limit` per call). Returns the expired entries. */
export async function expireDueOffers(db: D1Database, now: number, limit: number): Promise<{ id: string; slot_id: string; request_id: string }[]> {
  const r = await db
    .prepare("UPDATE scrim_waitlist SET status = 'expired', updated_at = ?1 WHERE id IN (SELECT id FROM scrim_waitlist WHERE status = 'offered' AND offer_expires_at <= ?1 LIMIT ?2) RETURNING id, slot_id, request_id")
    .bind(now, limit)
    .all<{ id: string; slot_id: string; request_id: string }>();
  return r.results;
}
export async function expireDueOffersOfSlot(db: D1Database, slotId: string, now: number): Promise<{ id: string; slot_id: string; request_id: string }[]> {
  return (
    await db
      .prepare("UPDATE scrim_waitlist SET status = 'expired', updated_at = ?2 WHERE slot_id = ?1 AND status = 'offered' AND offer_expires_at <= ?2 RETURNING id, slot_id, request_id")
      .bind(slotId, now)
      .all<{ id: string; slot_id: string; request_id: string }>()
  ).results;
}
/** An expired, declined or removed entry closes its request too (status declined), so it can never be accepted by mistake. */
export async function closeRequestOfEntry(db: D1Database, requestId: string, at: number): Promise<void> {
  await db.prepare("UPDATE scrim_requests SET status = 'declined', responded_at = ?2 WHERE id = ?1 AND status = 'sent'").bind(requestId, at).run();
}

/**
 * The offered team accepts: entry offered -> accepted, request sent -> accepted, one seat taken, a slot number given; all in ONE batch and only while the
 * offer is still valid and the scrim is open with room and has not started. Returns whether it happened.
 */
export async function acceptOffer(db: D1Database, e: { id: string; requestId: string; slotId: string }, now: number): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare("UPDATE scrim_waitlist SET status = 'accepted', updated_at = ?3 WHERE id = ?1 AND status = 'offered' AND offer_expires_at > ?3 AND EXISTS (SELECT 1 FROM scrim_slots s WHERE s.id = ?2 AND s.status = 'open' AND s.slots_filled < s.slots_total AND s.starts_at > ?3)")
      .bind(e.id, e.slotId, now),
    db.prepare("UPDATE scrim_requests SET status = 'accepted', responded_at = ?3 WHERE id = ?1 AND status = 'sent' AND (SELECT status FROM scrim_waitlist WHERE id = ?2) = 'accepted'").bind(e.requestId, e.id, now),
    db
      .prepare("UPDATE scrim_slots SET slots_filled = slots_filled + 1, status = CASE WHEN slots_filled + 1 >= slots_total THEN 'full' ELSE status END, updated_at = ?3 WHERE id = ?1 AND changes() = 1")
      .bind(e.slotId, e.requestId, now),
    assignSeatStatement(db, e.requestId, e.slotId, now),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- notifications
export async function notify(db: D1Database, n: { id: string; userId: string; kind: "waitlist_offer" | "offer_expired" | "removed_from_scrim"; slotId: string; at: number }): Promise<void> {
  await db.prepare("INSERT INTO scrim_notifications (id, user_id, kind, slot_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(n.id, n.userId, n.kind, n.slotId, n.at).run();
}
export interface NoticeRow { id: string; kind: string; slot_id: string | null; read_at: number | null; created_at: number; game: string | null; starts_at: number | null; poster_team: string | null }
export async function notices(db: D1Database, userId: string): Promise<NoticeRow[]> {
  return (
    await db
      .prepare("SELECT n.id, n.kind, n.slot_id, n.read_at, n.created_at, s.game, s.starts_at, tp.name AS poster_team FROM scrim_notifications n LEFT JOIN scrim_slots s ON s.id = n.slot_id LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE n.user_id = ?1 ORDER BY n.created_at DESC, n.id LIMIT 50")
      .bind(userId)
      .all<NoticeRow>()
  ).results;
}
export async function markNoticesRead(db: D1Database, userId: string, at: number): Promise<void> {
  await db.prepare("UPDATE scrim_notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL").bind(userId, at).run();
}
export async function deleteOldNotices(db: D1Database, before: number): Promise<number> {
  return (await db.prepare("DELETE FROM scrim_notifications WHERE id IN (SELECT id FROM scrim_notifications WHERE created_at < ?1 LIMIT 500)").bind(before).run()).meta?.changes ?? 0;
}

// ---------------------------------------------------------------- schedules
export interface ScheduleRow {
  id: string; poster_user_id: string; team_profile_id: string; game: string; time_of_day: string; days_ahead: number; region: string; server: string | null; skill_note: string | null;
  slots_total: number; contact: string; active: number; created_at: number; updated_at: number; team_name: string | null;
}
export async function findSchedule(db: D1Database, id: string): Promise<ScheduleRow | null> {
  return (await db.prepare("SELECT s.*, tp.name AS team_name FROM scrim_schedules s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE s.id = ?1").bind(id).first<ScheduleRow>()) ?? null;
}
export async function schedulesOf(db: D1Database, userId: string): Promise<ScheduleRow[]> {
  return (await db.prepare("SELECT s.*, tp.name AS team_name FROM scrim_schedules s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE s.poster_user_id = ?1 ORDER BY s.created_at LIMIT 20").bind(userId).all<ScheduleRow>()).results;
}
export type ScheduleInsert = Omit<ScheduleRow, "active" | "created_at" | "updated_at" | "team_name"> & { at: number };
/** Inserts a schedule while the user has fewer than `cap` schedules (one statement). */
export async function insertScheduleCapped(db: D1Database, s: ScheduleInsert, cap: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO scrim_schedules (id, poster_user_id, team_profile_id, game, time_of_day, days_ahead, region, server, skill_note, slots_total, contact, active, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?12 WHERE (SELECT COUNT(*) FROM scrim_schedules WHERE poster_user_id = ?2) < ?13`,
    )
    .bind(s.id, s.poster_user_id, s.team_profile_id, s.game, s.time_of_day, s.days_ahead, s.region, s.server, s.skill_note, s.slots_total, s.contact, s.at, cap)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}
export async function updateSchedule(db: D1Database, id: string, ownerId: string, p: { team_profile_id: string; game: string; time_of_day: string; days_ahead: number; region: string; server: string | null; skill_note: string | null; slots_total: number; contact: string; active: number }, at: number): Promise<void> {
  await db
    .prepare("UPDATE scrim_schedules SET team_profile_id = ?3, game = ?4, time_of_day = ?5, days_ahead = ?6, region = ?7, server = ?8, skill_note = ?9, slots_total = ?10, contact = ?11, active = ?12, updated_at = ?13 WHERE id = ?1 AND poster_user_id = ?2")
    .bind(id, ownerId, p.team_profile_id, p.game, p.time_of_day, p.days_ahead, p.region, p.server, p.skill_note, p.slots_total, p.contact, p.active, at)
    .run();
}
export interface DayRow { day: string; slot_id: string | null; skipped: number; starts_at: number | null; slot_status: string | null; slots_filled: number | null; slots_total: number | null }
export async function scheduleDays(db: D1Database, scheduleId: string, fromDay: string): Promise<DayRow[]> {
  return (
    await db
      .prepare("SELECT d.day, d.slot_id, d.skipped, s.starts_at, s.status AS slot_status, s.slots_filled, s.slots_total FROM scrim_schedule_days d LEFT JOIN scrim_slots s ON s.id = d.slot_id WHERE d.schedule_id = ?1 AND d.day >= ?2 ORDER BY d.day LIMIT 30")
      .bind(scheduleId, fromDay)
      .all<DayRow>()
  ).results;
}
/** Creates the slot of one schedule day unless that day already has a row (made or skipped). One batch; returns whether a slot was made. */
export async function generateDay(db: D1Database, sc: ScheduleRow, day: string, slotId: string, startsAt: number, at: number): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO scrim_slots (id, poster_user_id, team_profile_id, game, starts_at, region, server, skill_note, slots_total, slots_filled, contact, status, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, 'open', ?11, ?11 WHERE NOT EXISTS (SELECT 1 FROM scrim_schedule_days WHERE schedule_id = ?12 AND day = ?13)`,
      )
      .bind(slotId, sc.poster_user_id, sc.team_profile_id, sc.game, startsAt, sc.region, sc.server, sc.skill_note, sc.slots_total, sc.contact, at, sc.id, day),
    db.prepare("INSERT OR IGNORE INTO scrim_schedule_days (schedule_id, day, slot_id, skipped) SELECT ?1, ?2, ?3, 0 WHERE EXISTS (SELECT 1 FROM scrim_slots WHERE id = ?3)").bind(sc.id, day, slotId),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}
/** Marks a day skipped (creating its row when it was not generated yet). Returns the day's slot id, if it had one. */
export async function skipDay(db: D1Database, scheduleId: string, day: string): Promise<string | null> {
  const cur = await db.prepare("SELECT slot_id FROM scrim_schedule_days WHERE schedule_id = ?1 AND day = ?2").bind(scheduleId, day).first<{ slot_id: string | null }>();
  await db.prepare("INSERT INTO scrim_schedule_days (schedule_id, day, slot_id, skipped) VALUES (?1, ?2, NULL, 1) ON CONFLICT (schedule_id, day) DO UPDATE SET skipped = 1").bind(scheduleId, day).run();
  return cur?.slot_id ?? null;
}
export async function activeSchedules(db: D1Database, limit: number): Promise<ScheduleRow[]> {
  return (await db.prepare("SELECT s.*, NULL AS team_name FROM scrim_schedules s WHERE s.active = 1 ORDER BY s.updated_at, s.id LIMIT ?1").bind(limit).all<ScheduleRow>()).results;
}
export async function touchSchedule(db: D1Database, id: string, at: number): Promise<void> {
  await db.prepare("UPDATE scrim_schedules SET updated_at = ?2 WHERE id = ?1").bind(id, at).run();
}
/** Stops a schedule: its future slots nobody joined are cancelled, then the schedule is deleted (its day rows cascade). */
export async function deleteSchedule(db: D1Database, id: string, ownerId: string, now: number): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare("UPDATE scrim_slots SET status = 'cancelled', updated_at = ?3 WHERE id IN (SELECT slot_id FROM scrim_schedule_days WHERE schedule_id = ?1) AND poster_user_id = ?2 AND status = 'open' AND starts_at > ?3 AND slots_filled = 0")
      .bind(id, ownerId, now),
    db.prepare("DELETE FROM scrim_schedules WHERE id = ?1 AND poster_user_id = ?2").bind(id, ownerId),
  ]);
  return (res[1]?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- export
export async function exportSchedules(db: D1Database, userId: string): Promise<{ game: string; time_of_day: string; days_ahead: number; region: string; slots_total: number; contact: string; active: number; created_at: number }[]> {
  return (await db.prepare("SELECT game, time_of_day, days_ahead, region, slots_total, contact, active, created_at FROM scrim_schedules WHERE poster_user_id = ?1 ORDER BY created_at LIMIT 20").bind(userId).all<{ game: string; time_of_day: string; days_ahead: number; region: string; slots_total: number; contact: string; active: number; created_at: number }>()).results;
}
export async function exportEntries(db: D1Database, userId: string): Promise<{ slot_id: string; status: string; created_at: number }[]> {
  return (await db.prepare("SELECT w.slot_id, w.status, w.created_at FROM scrim_waitlist w JOIN scrim_requests q ON q.id = w.request_id WHERE q.requester_user_id = ?1 ORDER BY w.created_at LIMIT 200").bind(userId).all<{ slot_id: string; status: string; created_at: number }>()).results;
}
export async function exportNotices(db: D1Database, userId: string): Promise<{ kind: string; created_at: number; read_at: number | null }[]> {
  return (await db.prepare("SELECT kind, created_at, read_at FROM scrim_notifications WHERE user_id = ?1 ORDER BY created_at LIMIT 200").bind(userId).all<{ kind: string; created_at: number; read_at: number | null }>()).results;
}

/**
 * Phase 4 (migration 0056): scrim_slots, scrim_requests, scrim_reports, scrim_blocks. The only place these tables are queried.
 * A repository never decides who may see a row: the service checks ownership, 18+, blocks and expiry. Constant SQL only; every value is bound.
 * Seat numbers (migration 0057, scrim manager) are given and freed in the same batches as accept and withdraw.
 */
import { assignSeatStatement, releaseSeatStatement } from "./scrim-manager-repo";

export async function scrimTablesExist(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'scrim_slots'").first()) !== null;
}

/** The team page (legacy team_profiles) when the user owns it: a captain posts and requests for a team page they own. */
export async function ownedTeamName(db: D1Database, userId: string, teamProfileId: string): Promise<string | null> {
  return (await db.prepare("SELECT name FROM team_profiles WHERE id = ?1 AND owner_user_id = ?2").bind(teamProfileId, userId).first<{ name: string }>())?.name ?? null;
}

export interface SlotRow {
  id: string; poster_user_id: string; team_profile_id: string; game: string; starts_at: number; region: string; server: string | null; skill_note: string | null;
  slots_total: number; slots_filled: number; contact: string; status: string; hidden_at: number | null; report_count: number; created_at: number; updated_at: number; team_name: string | null;
}
export async function findSlot(db: D1Database, id: string): Promise<SlotRow | null> {
  return (await db.prepare("SELECT s.*, tp.name AS team_name FROM scrim_slots s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE s.id = ?1").bind(id).first<SlotRow>()) ?? null;
}

export interface SlotInsert { id: string; posterUserId: string; teamProfileId: string; game: string; startsAt: number; region: string; server: string | null; skillNote: string | null; slotsTotal: number; contact: string; at: number }
/** Inserts a slot only while the poster has fewer than `cap` open upcoming slots (one atomic statement). False when the cap is reached. */
export async function insertSlotCapped(db: D1Database, s: SlotInsert, cap: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO scrim_slots (id, poster_user_id, team_profile_id, game, starts_at, region, server, skill_note, slots_total, slots_filled, contact, status, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, 'open', ?11, ?11
       WHERE (SELECT COUNT(*) FROM scrim_slots WHERE poster_user_id = ?2 AND status IN ('open','full') AND starts_at > ?11) < ?12`,
    )
    .bind(s.id, s.posterUserId, s.teamProfileId, s.game, s.startsAt, s.region, s.server, s.skillNote, s.slotsTotal, s.contact, s.at, cap)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

export interface BoardFilter { now: number; game?: string; region?: string; from?: number; to?: number; cursor?: { ts: number; id: string }; limit: number }
export interface PublicSlotRow { id: string; game: string; starts_at: number; region: string; server: string | null; skill_note: string | null; slots_total: number; slots_filled: number; created_at: number; team_name: string | null }

/** Open or full (phase 4b: a full scrim shows so captains can join its waitlist), not hidden, upcoming slots. Soonest first. Explicit columns: poster id, contact and report data are never read here. */
export async function listPublic(db: D1Database, f: BoardFilter): Promise<PublicSlotRow[]> {
  const r = await db
    .prepare(
      `SELECT s.id, s.game, s.starts_at, s.region, s.server, s.skill_note, s.slots_total, s.slots_filled, s.created_at, tp.name AS team_name
       FROM scrim_slots s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id
       WHERE s.status IN ('open','full') AND s.hidden_at IS NULL AND s.starts_at > ?1
         AND (?2 IS NULL OR s.game = ?2) AND (?3 IS NULL OR s.region = ?3) AND (?4 IS NULL OR s.starts_at >= ?4) AND (?5 IS NULL OR s.starts_at < ?5)
         AND (?6 IS NULL OR s.starts_at > ?6 OR (s.starts_at = ?6 AND s.id > ?7))
       ORDER BY s.starts_at ASC, s.id ASC LIMIT ?8`,
    )
    .bind(f.now, f.game ?? null, f.region ?? null, f.from ?? null, f.to ?? null, f.cursor?.ts ?? null, f.cursor?.id ?? null, f.limit)
    .all<PublicSlotRow>();
  return r.results;
}

export type ViewerSlotRow = PublicSlotRow & { mine: number; my_request: string | null };
/** The same board for a signed-in captain: slots of anyone they blocked or who blocked them are left out; their own slots and requests are marked. */
export async function listForViewer(db: D1Database, f: BoardFilter, viewer: string): Promise<ViewerSlotRow[]> {
  const r = await db
    .prepare(
      `SELECT s.id, s.game, s.starts_at, s.region, s.server, s.skill_note, s.slots_total, s.slots_filled, s.created_at, tp.name AS team_name,
         CASE WHEN s.poster_user_id = ?9 THEN 1 ELSE 0 END AS mine,
         (SELECT q.status FROM scrim_requests q WHERE q.slot_id = s.id AND q.requester_user_id = ?9) AS my_request
       FROM scrim_slots s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id
       WHERE s.status IN ('open','full') AND s.hidden_at IS NULL AND s.starts_at > ?1
         AND (?2 IS NULL OR s.game = ?2) AND (?3 IS NULL OR s.region = ?3) AND (?4 IS NULL OR s.starts_at >= ?4) AND (?5 IS NULL OR s.starts_at < ?5)
         AND (?6 IS NULL OR s.starts_at > ?6 OR (s.starts_at = ?6 AND s.id > ?7))
         AND NOT EXISTS (SELECT 1 FROM scrim_blocks b WHERE (b.blocker_user_id = ?9 AND b.blocked_user_id = s.poster_user_id) OR (b.blocker_user_id = s.poster_user_id AND b.blocked_user_id = ?9))
       ORDER BY s.starts_at ASC, s.id ASC LIMIT ?8`,
    )
    .bind(f.now, f.game ?? null, f.region ?? null, f.from ?? null, f.to ?? null, f.cursor?.ts ?? null, f.cursor?.id ?? null, f.limit, viewer)
    .all<ViewerSlotRow>();
  return r.results;
}

export async function findPublicSlot(db: D1Database, id: string, now: number): Promise<PublicSlotRow | null> {
  return (
    (await db
      .prepare(
        `SELECT s.id, s.game, s.starts_at, s.region, s.server, s.skill_note, s.slots_total, s.slots_filled, s.created_at, tp.name AS team_name
         FROM scrim_slots s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE s.id = ?1 AND s.status IN ('open','full') AND s.hidden_at IS NULL AND s.starts_at > ?2`,
      )
      .bind(id, now)
      .first<PublicSlotRow>()) ?? null
  );
}

export type MySlotRow = SlotRow & { pending: number; accepted: number };
export async function listMine(db: D1Database, userId: string): Promise<MySlotRow[]> {
  return (
    await db
      .prepare(
        `SELECT s.*, tp.name AS team_name, (SELECT COUNT(*) FROM scrim_requests q WHERE q.slot_id = s.id AND q.status = 'sent') AS pending,
           (SELECT COUNT(*) FROM scrim_requests q WHERE q.slot_id = s.id AND q.status = 'accepted') AS accepted
         FROM scrim_slots s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE s.poster_user_id = ?1 ORDER BY s.starts_at DESC LIMIT 50`,
      )
      .bind(userId)
      .all<MySlotRow>()
  ).results;
}

/** open|full -> cancelled, only the poster, only before it starts. */
export async function cancelSlot(db: D1Database, id: string, posterId: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE scrim_slots SET status = 'cancelled', updated_at = ?3 WHERE id = ?1 AND poster_user_id = ?2 AND status IN ('open','full') AND starts_at > ?3").bind(id, posterId, now).run();
  return (r.meta?.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- requests
export async function insertRequest(db: D1Database, q: { id: string; slotId: string; requesterUserId: string; teamProfileId: string; message: string | null; contact: string; at: number }): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO scrim_requests (id, slot_id, requester_user_id, team_profile_id, message, contact, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sent', ?7)")
      .bind(q.id, q.slotId, q.requesterUserId, q.teamProfileId, q.message, q.contact, q.at)
      .run();
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) return false;
    throw e;
  }
}
export interface RequestRow { id: string; slot_id: string; requester_user_id: string; team_profile_id: string; message: string | null; contact: string; status: string; responded_at: number | null; created_at: number }
export async function findRequest(db: D1Database, id: string): Promise<RequestRow | null> {
  return (await db.prepare("SELECT id, slot_id, requester_user_id, team_profile_id, message, contact, status, responded_at, created_at FROM scrim_requests WHERE id = ?1").bind(id).first<RequestRow>()) ?? null;
}
export interface RequestForPoster { id: string; team_name: string | null; message: string | null; contact: string; status: string; created_at: number; responded_at: number | null; waitlist_status: string | null; slot_no: number | null }
export async function requestsForSlot(db: D1Database, slotId: string): Promise<RequestForPoster[]> {
  return (
    await db
      .prepare("SELECT q.id, tp.name AS team_name, q.message, q.contact, q.status, q.created_at, q.responded_at, (SELECT w.status FROM scrim_waitlist w WHERE w.request_id = q.id) AS waitlist_status, (SELECT a.slot_no FROM scrim_slot_assignments a WHERE a.request_id = q.id) AS slot_no FROM scrim_requests q LEFT JOIN team_profiles tp ON tp.id = q.team_profile_id WHERE q.slot_id = ?1 ORDER BY q.created_at LIMIT 100")
      .bind(slotId)
      .all<RequestForPoster>()
  ).results;
}
export interface RequestForRequester { id: string; slot_id: string; status: string; created_at: number; responded_at: number | null; game: string; starts_at: number; region: string; slot_status: string; poster_team: string | null; my_team: string | null; poster_contact: string }
export async function myRequests(db: D1Database, userId: string): Promise<RequestForRequester[]> {
  return (
    await db
      .prepare(
        `SELECT q.id, q.slot_id, q.status, q.created_at, q.responded_at, s.game, s.starts_at, s.region, s.status AS slot_status, pt.name AS poster_team, mt.name AS my_team, s.contact AS poster_contact
         FROM scrim_requests q JOIN scrim_slots s ON s.id = q.slot_id LEFT JOIN team_profiles pt ON pt.id = s.team_profile_id LEFT JOIN team_profiles mt ON mt.id = q.team_profile_id
         WHERE q.requester_user_id = ?1 ORDER BY s.starts_at DESC LIMIT 100`,
      )
      .bind(userId)
      .all<RequestForRequester>()
  ).results;
}

/** sent -> accepted AND one seat taken, atomically: only while the slot is open, has room and has not started. Returns whether it happened. */
export async function acceptRequest(db: D1Database, requestId: string, slotId: string, now: number): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare("UPDATE scrim_requests SET status = 'accepted', responded_at = ?3 WHERE id = ?1 AND slot_id = ?2 AND status = 'sent' AND EXISTS (SELECT 1 FROM scrim_slots s WHERE s.id = ?2 AND s.status = 'open' AND s.slots_filled < s.slots_total AND s.starts_at > ?3)")
      .bind(requestId, slotId, now),
    db
      .prepare("UPDATE scrim_slots SET slots_filled = slots_filled + 1, status = CASE WHEN slots_filled + 1 >= slots_total THEN 'full' ELSE status END, updated_at = ?2 WHERE id = ?1 AND changes() = 1")
      .bind(slotId, now),
    assignSeatStatement(db, requestId, slotId, now),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}
export async function declineRequest(db: D1Database, requestId: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE scrim_requests SET status = 'declined', responded_at = ?2 WHERE id = ?1 AND status = 'sent'").bind(requestId, now).run();
  return (r.meta?.changes ?? 0) === 1;
}
/** The requester withdraws a sent or accepted request; an accepted one gives its seat back (a full slot opens again). */
export async function withdrawRequest(db: D1Database, requestId: string, requesterId: string, now: number): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare(
        "UPDATE scrim_slots SET slots_filled = MAX(0, slots_filled - 1), status = CASE WHEN status = 'full' THEN 'open' ELSE status END, updated_at = ?3 WHERE id = (SELECT slot_id FROM scrim_requests WHERE id = ?1) AND EXISTS (SELECT 1 FROM scrim_requests WHERE id = ?1 AND requester_user_id = ?2 AND status = 'accepted')",
      )
      .bind(requestId, requesterId, now),
    db.prepare("UPDATE scrim_requests SET status = 'withdrawn', responded_at = ?3 WHERE id = ?1 AND requester_user_id = ?2 AND status IN ('sent','accepted')").bind(requestId, requesterId, now),
    releaseSeatStatement(db, requestId),
  ]);
  return (res[1]?.meta.changes ?? 0) === 1;
}

/** The poster removes a CONFIRMED team: accepted -> declined, the seat and its number are given back (a full slot opens again). */
export async function removeAccepted(db: D1Database, requestId: string, slotId: string, posterId: string, now: number): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare("UPDATE scrim_slots SET slots_filled = MAX(0, slots_filled - 1), status = CASE WHEN status = 'full' THEN 'open' ELSE status END, updated_at = ?3 WHERE id = ?1 AND poster_user_id = ?4 AND EXISTS (SELECT 1 FROM scrim_requests WHERE id = ?2 AND slot_id = ?1 AND status = 'accepted')")
      .bind(slotId, requestId, now, posterId),
    db.prepare("UPDATE scrim_requests SET status = 'declined', responded_at = ?2 WHERE id = ?1 AND status = 'accepted' AND changes() = 1").bind(requestId, now),
    releaseSeatStatement(db, requestId),
  ]);
  return (res[1]?.meta.changes ?? 0) === 1;
}

/** Poster edits an open slot before it starts. `slotsTotal` never goes below the seats taken; a full slot with new seats opens again. */
export async function updateSlot(db: D1Database, id: string, posterId: string, p: { startsAt: number; server: string | null; skillNote: string | null; slotsTotal: number }, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE scrim_slots SET starts_at = ?3, server = ?4, skill_note = ?5, slots_total = ?6, status = CASE WHEN slots_filled >= ?6 THEN 'full' ELSE 'open' END, updated_at = ?7
       WHERE id = ?1 AND poster_user_id = ?2 AND status IN ('open','full') AND starts_at > ?7 AND slots_filled <= ?6`,
    )
    .bind(id, posterId, p.startsAt, p.server, p.skillNote, p.slotsTotal, now)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- blocks
export async function insertBlock(db: D1Database, b: { id: string; blocker: string; blocked: string; label: string; at: number }): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO scrim_blocks (id, blocker_user_id, blocked_user_id, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(b.id, b.blocker, b.blocked, b.label, b.at).run();
}
/** After a poster blocks a requester: that requester's unanswered requests on the poster's slots are declined. */
export async function declinePendingFrom(db: D1Database, posterId: string, requesterId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE scrim_requests SET status = 'declined', responded_at = ?3 WHERE requester_user_id = ?2 AND status = 'sent' AND slot_id IN (SELECT id FROM scrim_slots WHERE poster_user_id = ?1)")
    .bind(posterId, requesterId, now)
    .run();
}
export async function blockedEitherWay(db: D1Database, a: string, b: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM scrim_blocks WHERE (blocker_user_id = ?1 AND blocked_user_id = ?2) OR (blocker_user_id = ?2 AND blocked_user_id = ?1)").bind(a, b).first()) !== null;
}
export async function listBlocks(db: D1Database, blocker: string): Promise<{ id: string; label: string; created_at: number }[]> {
  return (await db.prepare("SELECT id, label, created_at FROM scrim_blocks WHERE blocker_user_id = ?1 ORDER BY created_at DESC LIMIT 200").bind(blocker).all<{ id: string; label: string; created_at: number }>()).results;
}
export async function deleteBlock(db: D1Database, id: string, blocker: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM scrim_blocks WHERE id = ?1 AND blocker_user_id = ?2").bind(id, blocker).run();
  return (r.meta?.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- reports and staff
export async function fileSlotReport(
  db: D1Database,
  r: { id: string; slotId: string; reporter: string; reasonCode: string; note: string; at: number },
  threshold: number,
  autoHide: boolean,
  hideNow: boolean,
): Promise<boolean> {
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO scrim_reports (id, slot_id, reporter, reason_code, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(r.id, r.slotId, r.reporter, r.reasonCode, r.note, r.at),
    db.prepare("UPDATE scrim_slots SET report_count = (SELECT COUNT(DISTINCT reporter) FROM scrim_reports WHERE slot_id = ?1) WHERE id = ?1").bind(r.slotId),
    db.prepare("UPDATE scrim_slots SET hidden_at = ?2, updated_at = ?2 WHERE id = ?1 AND hidden_at IS NULL AND ?3 = 1 AND (?4 = 1 OR report_count >= ?5)").bind(r.slotId, r.at, autoHide ? 1 : 0, hideNow ? 1 : 0, threshold),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}
export interface HiddenSlotRow { id: string; game: string; starts_at: number; skill_note: string | null; team_name: string | null; status: string; hidden_at: number; report_count: number }
export async function listHidden(db: D1Database): Promise<HiddenSlotRow[]> {
  return (
    await db
      .prepare("SELECT s.id, s.game, s.starts_at, s.skill_note, tp.name AS team_name, s.status, s.hidden_at, s.report_count FROM scrim_slots s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE s.hidden_at IS NOT NULL AND s.status IN ('open','full') ORDER BY s.hidden_at DESC LIMIT 100")
      .all<HiddenSlotRow>()
  ).results;
}
export async function restoreSlot(db: D1Database, id: string, at: number): Promise<boolean> {
  const res = await db.batch([
    db.prepare("UPDATE scrim_slots SET hidden_at = NULL, report_count = 0, updated_at = ?2 WHERE id = ?1 AND hidden_at IS NOT NULL").bind(id, at),
    db.prepare("DELETE FROM scrim_reports WHERE slot_id = ?1").bind(id),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}
export async function removeSlot(db: D1Database, id: string, at: number): Promise<boolean> {
  const r = await db.prepare("UPDATE scrim_slots SET status = 'removed', hidden_at = COALESCE(hidden_at, ?2), updated_at = ?2 WHERE id = ?1 AND status IN ('open','full')").bind(id, at).run();
  return (r.meta?.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- retention, account deletion, export
/** Deletes (requests and reports cascade) slots that started more than `afterSec` ago. At most 500 per run. */
export async function deleteOldSlots(db: D1Database, now: number, afterSec: number): Promise<number> {
  const r = await db.prepare("DELETE FROM scrim_slots WHERE id IN (SELECT id FROM scrim_slots WHERE starts_at <= ?1 LIMIT 500)").bind(now - afterSec).run();
  return r.meta?.changes ?? 0;
}
/**
 * Statements that run BEFORE `DELETE FROM users` in the same batch. Slots, requests and blocks cascade with the account; this gives back the seats the user
 * held on other captains' slots (a full slot opens again) and deletes the reports the user filed (keyed by a hash of the account).
 */
export function accountDeletionStatements(db: D1Database, userId: string, reporterKey: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE scrim_slots SET slots_filled = MAX(0, slots_filled - (SELECT COUNT(*) FROM scrim_requests q WHERE q.slot_id = scrim_slots.id AND q.requester_user_id = ?1 AND q.status = 'accepted')),
           status = CASE WHEN status = 'full' THEN 'open' ELSE status END
         WHERE poster_user_id != ?1 AND id IN (SELECT slot_id FROM scrim_requests WHERE requester_user_id = ?1 AND status = 'accepted')`,
      )
      .bind(userId),
    db.prepare("DELETE FROM scrim_reports WHERE reporter = ?1").bind(reporterKey),
  ];
}
export interface SlotExportRow { id: string; game: string; starts_at: number; region: string; server: string | null; skill_note: string | null; slots_total: number; slots_filled: number; contact: string; status: string; created_at: number; requests_received: number }
export async function exportSlots(db: D1Database, userId: string): Promise<SlotExportRow[]> {
  return (
    await db
      .prepare("SELECT s.id, s.game, s.starts_at, s.region, s.server, s.skill_note, s.slots_total, s.slots_filled, s.contact, s.status, s.created_at, (SELECT COUNT(*) FROM scrim_requests q WHERE q.slot_id = s.id) AS requests_received FROM scrim_slots s WHERE s.poster_user_id = ?1 ORDER BY s.created_at DESC LIMIT 200")
      .bind(userId)
      .all<SlotExportRow>()
  ).results;
}
export interface RequestExportRow { slot_id: string; message: string | null; contact: string; status: string; created_at: number; responded_at: number | null }
export async function exportRequests(db: D1Database, userId: string): Promise<RequestExportRow[]> {
  return (await db.prepare("SELECT slot_id, message, contact, status, created_at, responded_at FROM scrim_requests WHERE requester_user_id = ?1 ORDER BY created_at DESC LIMIT 500").bind(userId).all<RequestExportRow>()).results;
}
export async function exportBlocks(db: D1Database, userId: string): Promise<{ label: string; created_at: number }[]> {
  return (await db.prepare("SELECT label, created_at FROM scrim_blocks WHERE blocker_user_id = ?1 ORDER BY created_at DESC LIMIT 200").bind(userId).all<{ label: string; created_at: number }>()).results;
}

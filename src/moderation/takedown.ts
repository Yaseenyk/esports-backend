/**
 * Takedowns (blueprint 9.2, dev-review-r2 N-12 and 6.3). A takedown names an immutable id; the public routes ask `takenDown` (the sweep helper) and answer
 * with their normal "missing" response. Two moderation sources exist and BOTH are read here: S4's directory_entries.held_at and this table.
 *
 *  - `isTakenDown(db, kind, key)`: raw truth about one target (ignores the rollout flag). Used by staff tools and tests.
 *  - `takenDown(db, subject)`: what a public route calls. Honours flag `takedown.enforce`; also true when the target's EVENT is hidden or the event's
 *    organisation is suspended, so one hidden event hides every page of it.
 *  - Constant SQL only. One read per call.
 */
import { auditStmts, auditOff } from "../audit";
import { restoreDirectoryListing } from "../directory-admin";
import { getFlag } from "../flags";
import { isReasonCode, isTargetType, ID_RE, type TargetType } from "./codes";

export interface TakedownSubject {
  type: TargetType;
  /** The immutable id: event_id, team_profiles.id, share_links.id or captain_links.id. Never a slug or a token. */
  id: string;
  /** The page's event, when it has one: lets an event takedown and a suspended organisation hide the page too. */
  eventId?: string | null;
}

export type TakedownResult = { ok: true; changed: boolean } | { ok: false; code: "bad_input" | "reason_required" | "conflict_of_interest" | "not_hidden" };

const iso = (ms: number) => new Date(ms).toISOString();

/** Raw: is this exact target hidden by a takedown, or (for the directory) held by S4? Both sources. Ignores `takedown.enforce`. */
export async function isTakenDown(db: D1Database, kind: TargetType, key: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM takedowns WHERE target_type = ?1 AND target_id = ?2 AND state = 'hidden' UNION ALL SELECT 1 AS x FROM directory_entries WHERE ?1 = 'directory_entry' AND event_id = ?2 AND held_at IS NOT NULL LIMIT 1")
    .bind(kind, key)
    .first();
  return r !== null;
}

/**
 * The call each public route makes (the serial sweep). True means answer exactly as for a missing id. Reasons: the target is hidden (takedown or S4 hold),
 * its event is hidden, or its event's organisation is suspended. While flag `takedown.enforce` is off it answers false (the rollout switch; reports and
 * takedowns are still recorded). `opts.enforce` overrides the flag (tests, or a caller that already read it). One query.
 */
export async function takenDown(db: D1Database, subject: TakedownSubject, opts: { enforce?: boolean } = {}): Promise<boolean> {
  const enforce = opts.enforce ?? (await getFlag(db, "takedown.enforce"));
  if (!enforce) return false;
  const ev = subject.eventId ?? null;
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM takedowns WHERE state = 'hidden' AND ((target_type = ?1 AND target_id = ?2) OR (?3 IS NOT NULL AND target_type = 'event' AND target_id = ?3))  UNION ALL SELECT 1 AS x FROM directory_entries WHERE ?1 = 'directory_entry' AND event_id = ?2 AND held_at IS NOT NULL  UNION ALL SELECT 1 AS x FROM events e JOIN organisations o ON o.id = e.org_id WHERE ?3 IS NOT NULL AND e.id = ?3 AND o.status = 'suspended' LIMIT 1",
    )
    .bind(subject.type, subject.id, ev)
    .first();
  return r !== null;
}

/**
 * Self-interest guard: true when `staffId` owns, created or (through an organisation) belongs to the event the target hangs off, or owns the team page.
 * Staff can never decide a report or a takedown about their own organisation's event.
 */
export async function conflictOfInterest(db: D1Database, staffId: string, t: { type: TargetType; id: string; eventId?: string | null; orgId?: string | null }): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM events e WHERE e.id = ?2 AND (e.owner_id = ?1 OR e.created_by = ?1 OR EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = ?1 AND m.org_id = e.org_id)))  OR EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = ?1 AND m.org_id = ?3)  OR EXISTS (SELECT 1 FROM team_profiles p WHERE p.id = ?4 AND p.owner_user_id = ?1)",
    )
    .bind(staffId, t.eventId ?? null, t.orgId ?? null, t.type === "team_profile" ? t.id : null)
    .first();
  return r !== null;
}

export interface TakedownInput {
  targetType: TargetType;
  targetId: string;
  reasonCode: string;
  staffId: string;
  eventId?: string | null;
  orgId?: string | null;
  nowMs?: number;
}

/** Hide a target (staff action, reversible). Reason required. One audit row (takedown.hidden) when the state changes. Idempotent when already hidden. */
export async function createTakedown(db: D1Database, i: TakedownInput): Promise<TakedownResult> {
  if (!isTargetType(i.targetType) || !ID_RE.test(i.targetId) || !ID_RE.test(i.staffId)) return { ok: false, code: "bad_input" };
  if (!isReasonCode(i.reasonCode)) return { ok: false, code: "reason_required" };
  if (await conflictOfInterest(db, i.staffId, { type: i.targetType, id: i.targetId, eventId: i.eventId, orgId: i.orgId })) return { ok: false, code: "conflict_of_interest" };
  if (await isTakenDown(db, i.targetType, i.targetId)) return { ok: true, changed: false };
  const at = iso(i.nowMs ?? Date.now());
  await db.batch([
    db.prepare("INSERT INTO takedowns (target_type, target_id, state, reason_code, by_staff, at, event_id, org_id) VALUES (?1, ?2, 'hidden', ?3, ?4, ?5, ?6, ?7) ON CONFLICT (target_type, target_id) DO UPDATE SET state = 'hidden', reason_code = excluded.reason_code, by_staff = excluded.by_staff, at = excluded.at, event_id = excluded.event_id, org_id = excluded.org_id")
      .bind(i.targetType, i.targetId, i.reasonCode, i.staffId, at, i.eventId ?? null, i.orgId ?? null),
    ...auditStmts(db, { action: "takedown.hidden", actorType: "staff", actorId: i.staffId, orgId: i.orgId, eventId: i.eventId, targetType: i.targetType, targetId: i.targetId, reasonCode: i.reasonCode, at }, await auditOff(db)),
  ]);
  return { ok: true, changed: true };
}

/**
 * Restore a target (staff action, reversible). Reason required. Clears BOTH sources: the takedown row and, for a directory entry, S4's hold
 * (restoreDirectoryListing, which also resolves its open reports). Open reports on the target are closed as dismissed (kept as history, never deleted).
 * One audit row (takedown.restored). `not_hidden` when nothing was hiding it.
 */
export async function revokeTakedown(db: D1Database, i: TakedownInput): Promise<TakedownResult> {
  if (!isTargetType(i.targetType) || !ID_RE.test(i.targetId) || !ID_RE.test(i.staffId)) return { ok: false, code: "bad_input" };
  if (!isReasonCode(i.reasonCode)) return { ok: false, code: "reason_required" };
  if (await conflictOfInterest(db, i.staffId, { type: i.targetType, id: i.targetId, eventId: i.eventId, orgId: i.orgId })) return { ok: false, code: "conflict_of_interest" };
  if (!(await isTakenDown(db, i.targetType, i.targetId))) return { ok: false, code: "not_hidden" };
  const ms = i.nowMs ?? Date.now();
  const at = iso(ms);
  if (i.targetType === "directory_entry") await restoreDirectoryListing(db, i.targetId, ms);
  await db.batch([
    db.prepare("UPDATE takedowns SET state = 'restored', reason_code = ?3, by_staff = ?4, at = ?5 WHERE target_type = ?1 AND target_id = ?2 AND state = 'hidden'").bind(i.targetType, i.targetId, i.reasonCode, i.staffId, at),
    db.prepare("UPDATE reports SET status = 'dismissed', decided_by = ?3, decided_at = ?4, decision_code = ?5 WHERE target_type = ?1 AND target_id = ?2 AND status IN ('open','needs_other_staff')").bind(i.targetType, i.targetId, i.staffId, at, i.reasonCode),
    ...auditStmts(db, { action: "takedown.restored", actorType: "staff", actorId: i.staffId, orgId: i.orgId, eventId: i.eventId, targetType: i.targetType, targetId: i.targetId, reasonCode: i.reasonCode, at }, await auditOff(db)),
  ]);
  return { ok: true, changed: true };
}

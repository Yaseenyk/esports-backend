/**
 * Reports (blueprint 9.2, dev-review-r2 6.3). Filing, the queue, and the staff decision.
 *
 *  - `fileReport`: stores one report for an immutable target (or, for a directory entry, one row in S4's directory_reports) and applies auto-hide in the SAME
 *    batch: ONE `minor_exposed` report hides at once; otherwise three distinct open reporters hide. The same reporter counts once per target.
 *  - `listReports`: S4 directory reports UNION the generic ones, sorted priority, distinct reporters, then age. Offset cursor `after`.
 *  - `decideReport`: hide, restore or dismiss. Reason required. Self-interest guard: staff never decide a report about their own organisation's event.
 *  - Privacy: the reporter is a salted hash, the note is short sanitised text, nothing about the reporter's identity or any minor is stored.
 *  - Constant SQL only.
 */
import { audit, auditOff, auditStmts } from "../audit";
import { AUTO_HIDE_AT, ID_RE, hidesAtOnce, isReasonCode, priorityOf, sanitiseNote, type ReportReason, type TargetType } from "./codes";
import type { Target } from "./lookup";
import { conflictOfInterest, createTakedown, revokeTakedown } from "./takedown";

const iso = (ms: number) => new Date(ms).toISOString();
const rid = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
};

export interface FileReportInput {
  target: Target;
  reason: ReportReason;
  /** Untrusted: sanitised and capped here. */
  note?: unknown;
  /** Salted hash from `reporterHash`. */
  reporter: string;
  nowMs?: number;
}

export interface FileReportResult {
  /** False when this reporter already has an open report on this target (counted once). */
  stored: boolean;
  /** True when this call changed the target from visible to hidden (minor report, or the third distinct reporter). */
  hidden: boolean;
}

/** Stores a report and applies auto-hide. Never throws for a well-formed target; callers answer the visitor uniformly whatever this returns. */
export async function fileReport(db: D1Database, i: FileReportInput): Promise<FileReportResult> {
  const at = iso(i.nowMs ?? Date.now());
  const note = sanitiseNote(i.note);
  const t = i.target;
  const minor = hidesAtOnce(i.reason);

  if (t.type === "directory_entry") {
    // The directory keeps S4's mechanics: directory_reports (3 distinct open reporters hide it in the public read) and held_at (a minor report holds it at once).
    const text = note ? `${i.reason}: ${note}` : i.reason;
    const res = await db.batch([
      db.prepare("INSERT INTO directory_reports (id, event_id, reason, reporter, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM directory_reports WHERE event_id = ?2 AND reporter = ?4 AND resolved_at IS NULL)").bind(rid(), t.id, text.slice(0, 200), i.reporter, at),
      db.prepare("UPDATE directory_entries SET held_at = ?2 WHERE event_id = ?1 AND held_at IS NULL AND (?3 = 1 OR (SELECT COUNT(DISTINCT reporter) FROM directory_reports WHERE event_id = ?1 AND resolved_at IS NULL) >= ?4)").bind(t.id, at, minor ? 1 : 0, AUTO_HIDE_AT),
    ]);
    return { stored: (res[0]?.meta.changes ?? 0) === 1, hidden: (res[1]?.meta.changes ?? 0) === 1 };
  }

  const res = await db.batch([
    db.prepare("INSERT INTO reports (id, target_type, target_id, event_id, org_id, reason_code, note, reporter, status, priority, created_at, lookup_key) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10, ?11 WHERE NOT EXISTS (SELECT 1 FROM reports WHERE target_type = ?2 AND target_id = ?3 AND reporter = ?8 AND status = 'open')")
      .bind(rid(), t.type, t.id, t.eventId, t.orgId, i.reason, note, i.reporter, priorityOf(i.reason), at, t.lookupKey.slice(0, 64)),
    // Auto-hide, same batch: a minor report at once, otherwise AUTO_HIDE_AT distinct open reporters. Only a visible or staff-restored target changes; a staff hide keeps its reason.
    db.prepare("INSERT INTO takedowns (target_type, target_id, state, reason_code, by_staff, at, event_id, org_id) SELECT ?1, ?2, 'hidden', ?3, 'system', ?4, ?5, ?6 WHERE (?7 = 1 OR (SELECT COUNT(DISTINCT reporter) FROM reports WHERE target_type = ?1 AND target_id = ?2 AND status = 'open') >= ?8) ON CONFLICT (target_type, target_id) DO UPDATE SET state = 'hidden', reason_code = excluded.reason_code, by_staff = 'system', at = excluded.at WHERE takedowns.state = 'restored'")
      .bind(t.type, t.id, minor ? "minor_exposed" : "auto_reports", at, t.eventId, t.orgId, minor ? 1 : 0, AUTO_HIDE_AT),
  ]);
  const hidden = (res[1]?.meta.changes ?? 0) === 1;
  if (hidden) await audit(db, { action: "takedown.hidden", actorType: "system", orgId: t.orgId, eventId: t.eventId, targetType: t.type, targetId: t.id, reasonCode: minor ? "minor_exposed" : "auto_reports", at });
  return { stored: (res[0]?.meta.changes ?? 0) === 1, hidden };
}

// ---------- the queue ----------
export type ReportStatus = "open" | "actioned" | "dismissed" | "needs_other_staff";
export const REPORT_STATUSES: readonly ReportStatus[] = ["open", "actioned", "dismissed", "needs_other_staff"];

export interface QueueItem {
  /** 'report' (the generic table) or 'directory' (S4's directory_reports). decideReport needs both source and id. */
  source: "report" | "directory";
  id: string;
  targetType: string;
  targetId: string;
  eventId: string | null;
  orgId: string | null;
  reasonCode: string;
  note: string;
  status: string;
  priority: number;
  createdAt: string;
  lookupKey: string;
  /** Distinct reporters with an open report on the same target. */
  reporters: number;
}

interface QueueRow {
  source: "report" | "directory"; id: string; target_type: string; target_id: string; event_id: string | null; org_id: string | null;
  reason_code: string; note: string; status: string; priority: number; created_at: string; lookup_key: string; reporters: number;
}

export interface ListInput {
  status?: ReportStatus;
  /** Offset cursor: the number of items already seen (0 when absent). */
  after?: number;
  limit?: number;
}

/** The staff queue: both sources, one list, highest priority then most distinct reporters then oldest. Returns `next` (the next `after`) or null at the end. */
export async function listReports(db: D1Database, q: ListInput = {}): Promise<{ items: QueueItem[]; next: number | null }> {
  const status = q.status && REPORT_STATUSES.includes(q.status) ? q.status : "open";
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 25), 1), 50);
  const offset = Math.min(Math.max(Math.trunc(q.after ?? 0), 0), 100_000);
  const rows = await db
    .prepare(
      "SELECT * FROM (SELECT 'report' AS source, r.id AS id, r.target_type AS target_type, r.target_id AS target_id, r.event_id AS event_id, r.org_id AS org_id, r.reason_code AS reason_code, r.note AS note, r.status AS status, r.priority AS priority, r.created_at AS created_at, r.lookup_key AS lookup_key, (SELECT COUNT(DISTINCT x.reporter) FROM reports x WHERE x.target_type = r.target_type AND x.target_id = r.target_id AND x.status = 'open') AS reporters FROM reports r WHERE r.status = ?1 UNION ALL SELECT 'directory' AS source, d.id AS id, 'directory_entry' AS target_type, d.event_id AS target_id, d.event_id AS event_id, e.org_id AS org_id, CASE WHEN d.reason LIKE 'minor_exposed%' THEN 'minor_exposed' ELSE 'other' END AS reason_code, substr(d.reason, 1, 200) AS note, CASE WHEN d.resolved_at IS NULL THEN 'open' ELSE 'dismissed' END AS status, CASE WHEN d.reason LIKE 'minor_exposed%' THEN 3 ELSE 0 END AS priority, d.created_at AS created_at, d.event_id AS lookup_key, (SELECT COUNT(DISTINCT y.reporter) FROM directory_reports y WHERE y.event_id = d.event_id AND y.resolved_at IS NULL) AS reporters FROM directory_reports d LEFT JOIN events e ON e.id = d.event_id WHERE (CASE WHEN d.resolved_at IS NULL THEN 'open' ELSE 'dismissed' END) = ?1) ORDER BY priority DESC, reporters DESC, created_at ASC, id ASC LIMIT ?2 OFFSET ?3",
    )
    .bind(status, limit + 1, offset)
    .all<QueueRow>();
  const page = rows.results.slice(0, limit);
  return {
    items: page.map((r) => ({
      source: r.source, id: r.id, targetType: r.target_type, targetId: r.target_id, eventId: r.event_id, orgId: r.org_id, reasonCode: r.reason_code,
      note: r.note, status: r.status, priority: r.priority, createdAt: r.created_at, lookupKey: r.lookup_key, reporters: r.reporters,
    })),
    next: rows.results.length > limit ? offset + limit : null,
  };
}

// ---------- the decision ----------
export type Decision = "hide" | "restore" | "dismiss";
export interface DecideInput {
  source: "report" | "directory";
  reportId: string;
  decision: Decision;
  reasonCode: string;
  staffId: string;
  nowMs?: number;
}
export type DecideResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "bad_input" | "reason_required" | "not_found" | "conflict_of_interest" | "not_hidden" };

interface Subject { type: TargetType; id: string; eventId: string | null; orgId: string | null }

async function loadSubject(db: D1Database, source: "report" | "directory", id: string): Promise<Subject | null> {
  if (source === "directory") {
    const r = await db.prepare("SELECT d.event_id AS event_id, e.org_id AS org_id FROM directory_reports d LEFT JOIN events e ON e.id = d.event_id WHERE d.id = ?1").bind(id).first<{ event_id: string; org_id: string | null }>();
    return r ? { type: "directory_entry", id: r.event_id, eventId: r.event_id, orgId: r.org_id } : null;
  }
  const r = await db.prepare("SELECT target_type, target_id, event_id, org_id FROM reports WHERE id = ?1").bind(id).first<{ target_type: TargetType; target_id: string; event_id: string | null; org_id: string | null }>();
  return r ? { type: r.target_type, id: r.target_id, eventId: r.event_id, orgId: r.org_id } : null;
}

/**
 * Staff decision on a queue item. `hide` creates a takedown (and closes the open reports as actioned), `restore` lifts it (open reports dismissed, S4 hold
 * cleared), `dismiss` closes just this report. Reason code required. If the report concerns the staff member's own organisation's event the report is parked
 * as `needs_other_staff` and nothing changes. One audit row per call (report.decided, plus takedown.* for hide and restore).
 */
export async function decideReport(db: D1Database, i: DecideInput): Promise<DecideResult> {
  if ((i.source !== "report" && i.source !== "directory") || !ID_RE.test(i.reportId) || !ID_RE.test(i.staffId) || !["hide", "restore", "dismiss"].includes(i.decision)) return { ok: false, code: "bad_input" };
  if (!isReasonCode(i.reasonCode)) return { ok: false, code: "reason_required" };
  const s = await loadSubject(db, i.source, i.reportId);
  if (!s) return { ok: false, code: "not_found" };
  const at = iso(i.nowMs ?? Date.now());
  if (await conflictOfInterest(db, i.staffId, s)) {
    if (i.source === "report") await db.prepare("UPDATE reports SET status = 'needs_other_staff' WHERE id = ?1 AND status = 'open'").bind(i.reportId).run();
    return { ok: false, code: "conflict_of_interest" };
  }
  const common = { staffId: i.staffId, reasonCode: i.reasonCode, eventId: s.eventId, orgId: s.orgId, nowMs: i.nowMs };

  if (i.decision === "hide") {
    const r = await createTakedown(db, { targetType: s.type, targetId: s.id, ...common });
    if (!r.ok) return r;
    await closeReports(db, i, s, "actioned", at, "upheld");
    return { ok: true, changed: r.changed };
  }
  if (i.decision === "restore") {
    const r = await revokeTakedown(db, { targetType: s.type, targetId: s.id, ...common });
    if (!r.ok) return r;
    await audit(db, { action: "report.decided", actorType: "staff", actorId: i.staffId, orgId: s.orgId, eventId: s.eventId, targetType: s.type, targetId: s.id, reasonCode: i.reasonCode, meta: { decision: "dismissed" }, at });
    return { ok: true, changed: true };
  }
  await closeReports(db, i, s, "dismissed", at, "dismissed");
  return { ok: true, changed: true };
}

/** Closes this report (and, for an upheld hide, every other open report on the target) and writes the report.decided audit row in the same batch. */
async function closeReports(db: D1Database, i: DecideInput, s: Subject, status: "actioned" | "dismissed", at: string, outcome: "upheld" | "dismissed"): Promise<void> {
  const off = await auditOff(db);
  const entry = { action: "report.decided" as const, actorType: "staff" as const, actorId: i.staffId, orgId: s.orgId, eventId: s.eventId, targetType: s.type, targetId: s.id, reasonCode: i.reasonCode, meta: { decision: outcome }, at };
  if (i.source === "directory") {
    await db.batch([
      db.prepare("UPDATE directory_reports SET resolved_at = ?2 WHERE (id = ?1 OR (?3 = 1 AND event_id = ?4)) AND resolved_at IS NULL").bind(i.reportId, at, status === "actioned" ? 1 : 0, s.id),
      ...auditStmts(db, entry, off),
    ]);
    return;
  }
  await db.batch([
    db.prepare("UPDATE reports SET status = ?2, decided_by = ?3, decided_at = ?4, decision_code = ?5 WHERE status IN ('open','needs_other_staff') AND (id = ?1 OR (?6 = 1 AND target_type = ?7 AND target_id = ?8))").bind(i.reportId, status, i.staffId, at, i.reasonCode, status === "actioned" ? 1 : 0, s.type, s.id),
    ...auditStmts(db, entry, off),
  ]);
}

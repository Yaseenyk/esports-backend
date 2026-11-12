/**
 * Staff moderation routes (blueprint 9.2, 11.3). Thin wiring over src/moderation (stream R); every action here is REVERSIBLE (no DELETE route exists).
 *
 *  GET  /admin/v1/reports?status=&after=              the queue, { items, next }
 *  POST /admin/v1/reports/:id/decide                  { source?, decision: hide|restore|dismiss|takedown, reasonCode }  (`takedown` is an alias of `hide`)
 *  GET  /admin/v1/takedowns?after=                    what is hidden now, { items, next }
 *  POST /admin/v1/takedowns                           { targetType, targetId, reasonCode }  hide a target
 *  POST /admin/v1/takedowns/:type/:id/restore         { reasonCode }                        lift it (the "lift takedown" button)
 *
 * No step-up (reversible, blueprint 9.2). The self-interest guard is enforced by src/moderation (conflict_of_interest 403, the report is parked as
 * needs_other_staff). Event and organisation ids are DERIVED from the target here, never taken from the request, so a caller cannot dodge the guard.
 * Audit rows are written by the moderation functions (report.decided, takedown.hidden, takedown.restored).
 */
import { Hono } from "hono";
import { HttpError, readJson } from "../http";
import { createTakedown, decideReport, listReports, revokeTakedown, type Decision, type TakedownResult } from "../moderation";
import { isTargetType, ID_RE, type TargetType } from "../moderation/codes";
import type { ReportStatus } from "../moderation";
import { REPORT_STATUSES } from "../moderation";
import { reasonCodeOf } from "./flags";
import type { ACtx, AdminBindings } from "./session";

export const moderationRoutes = new Hono<AdminBindings>();

function failure(code: string): HttpError {
  switch (code) {
    case "not_found": return new HttpError(404, "Not found");
    case "conflict_of_interest": return new HttpError(403, "This concerns your own organisation's event: another staff member must decide", { code });
    case "not_hidden": return new HttpError(409, "Nothing is hidden for this target", { code });
    case "reason_required": return new HttpError(400, "reasonCode is required", { code });
    default: return new HttpError(400, "Bad input", { code: "bad_input" });
  }
}

const cursor = (v: string | undefined): number => {
  if (v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new HttpError(400, "after is not valid");
  return n;
};

moderationRoutes.get("/reports", async (c) => {
  const status = c.req.query("status");
  if (status !== undefined && !(REPORT_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "status is not valid");
  const r = await listReports(c.env.DB, { status: status as ReportStatus | undefined, after: cursor(c.req.query("after")) });
  return c.json({ items: r.items, next: r.next });
});

moderationRoutes.post("/reports/:id/decide", async (c) => {
  const staff = c.get("staff");
  const id = c.req.param("id");
  if (!ID_RE.test(id)) throw new HttpError(404, "Not found");
  const b = await readJson(c as never, 2048);
  const reasonCode = reasonCodeOf(b);
  const source = b.source === undefined ? "report" : b.source;
  if (source !== "report" && source !== "directory") throw new HttpError(400, "source must be report or directory");
  const raw = b.decision;
  const decision = raw === "takedown" ? "hide" : raw;
  if (decision !== "hide" && decision !== "restore" && decision !== "dismiss") throw new HttpError(400, "decision must be hide, restore, dismiss or takedown");
  const r = await decideReport(c.env.DB, { source, reportId: id, decision: decision as Decision, reasonCode, staffId: staff.id });
  if (!r.ok) throw failure(r.code);
  return c.json({ ok: true, id, decision, changed: r.changed });
});

interface TakedownRow { target_type: string; target_id: string; reason_code: string; by_staff: string; at: string; event_id: string | null; org_id: string | null }

moderationRoutes.get("/takedowns", async (c) => {
  const after = cursor(c.req.query("after"));
  const r = await c.env.DB.prepare("SELECT target_type, target_id, reason_code, by_staff, at, event_id, org_id FROM takedowns WHERE state = 'hidden' ORDER BY at DESC, target_type, target_id LIMIT 51 OFFSET ?1").bind(after).all<TakedownRow>();
  const page = r.results.slice(0, 50);
  return c.json({
    items: page.map((t) => ({ targetType: t.target_type, targetId: t.target_id, reasonCode: t.reason_code, byStaff: t.by_staff, at: t.at, eventId: t.event_id, orgId: t.org_id })),
    next: r.results.length > 50 ? after + 50 : null,
  });
});

/** The event and organisation a target hangs off, from the database (never from the caller). Null when the target does not exist. */
async function derive(db: D1Database, type: TargetType, id: string): Promise<{ eventId: string | null; orgId: string | null } | null> {
  type Row = { event_id: string | null; org_id: string | null };
  let r: Row | null;
  switch (type) {
    case "team_profile":
      r = await db.prepare("SELECT NULL AS event_id, NULL AS org_id FROM team_profiles WHERE id = ?1").bind(id).first<Row>();
      break;
    case "pass":
      r = await db.prepare("SELECT s.event_id AS event_id, e.org_id AS org_id FROM share_links s JOIN events e ON e.id = s.event_id WHERE s.id = ?1").bind(id).first<Row>();
      break;
    case "results":
      r = await db.prepare("SELECT c.event_id AS event_id, e.org_id AS org_id FROM captain_links c JOIN events e ON e.id = c.event_id WHERE c.id = ?1").bind(id).first<Row>();
      break;
    default:
      r = await db.prepare("SELECT e.id AS event_id, e.org_id AS org_id FROM events e WHERE e.id = ?1").bind(id).first<Row>();
  }
  return r ? { eventId: r.event_id, orgId: r.org_id } : null;
}

async function takedownAction(c: ACtx, type: unknown, id: unknown, b: Record<string, unknown>, hide: boolean) {
  const staff = c.get("staff");
  if (!isTargetType(type) || typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(400, "Bad input", { code: "bad_input" });
  const reasonCode = reasonCodeOf(b);
  const d = await derive(c.env.DB, type, id);
  // A restore must still work when the page row is gone (the takedown row is the truth); a new takedown needs a real target.
  if (!d && hide) throw new HttpError(404, "Not found");
  const input = { targetType: type, targetId: id, reasonCode, staffId: staff.id, eventId: d?.eventId ?? null, orgId: d?.orgId ?? null };
  const r: TakedownResult = hide ? await createTakedown(c.env.DB, input) : await revokeTakedown(c.env.DB, input);
  if (!r.ok) throw failure(r.code);
  return c.json({ ok: true, targetType: type, targetId: id, state: hide ? "hidden" : "restored", changed: r.changed });
}

moderationRoutes.post("/takedowns", async (c) => {
  const b = await readJson(c as never, 2048);
  return takedownAction(c, b.targetType, b.targetId, b, true);
});

moderationRoutes.post("/takedowns/:type/:id/restore", async (c) => {
  const b = await readJson(c as never, 2048);
  return takedownAction(c, c.req.param("type"), c.req.param("id"), b, false);
});

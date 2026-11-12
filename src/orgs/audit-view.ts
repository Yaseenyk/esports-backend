import { HttpError, type Ctx } from "../http";
import { requireOrg } from "./access";

/** GET /orgs/:id/audit?after=&limit= : the organisation's governance log, newest first. Capability org.audit.read (admins only). */
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;

export async function orgAudit(c: Ctx): Promise<Response> {
  const orgId = c.req.param("id")!;
  await requireOrg(c, orgId, "org.audit.read");
  const q = c.req.query();
  let limit = AUDIT_PAGE_DEFAULT;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) throw new HttpError(400, `limit must be a whole number from 1 to ${AUDIT_PAGE_MAX}`);
  }
  let after: number | null = null;
  if (q.after !== undefined) {
    after = Number(q.after);
    if (!Number.isInteger(after) || after < 1) throw new HttpError(400, "after must be a row id from a previous page");
  }
  const rows = await c.env.DB
    .prepare("SELECT id, at, actor_type, actor_id, event_id, action, target_type, target_id, reason_code, meta FROM audit_log WHERE org_id = ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3")
    .bind(orgId, after, limit + 1)
    .all<{ id: number; at: string; actor_type: string; actor_id: string; event_id: string | null; action: string; target_type: string; target_id: string; reason_code: string; meta: string }>();
  const page = rows.results.slice(0, limit);
  const parse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return {};
    }
  };
  c.header("cache-control", "private, no-store");
  return c.json({
    entries: page.map((r) => ({ id: r.id, at: r.at, actorType: r.actor_type, actorId: r.actor_id, eventId: r.event_id, action: r.action, targetType: r.target_type, targetId: r.target_id, reasonCode: r.reason_code, meta: parse(r.meta) })),
    next: rows.results.length > limit ? page[page.length - 1]!.id : null,
  });
}
